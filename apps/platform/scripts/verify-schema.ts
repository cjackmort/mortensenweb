/**
 * Assert the database actually has what the code expects.
 *
 * Runs immediately after `db:migrate`, against the same database, and exists
 * because a green migration command is not evidence in this repository.
 * Drizzle's Postgres migrator decides what to apply from a single high-water
 * mark:
 *
 *     select id, hash, created_at from drizzle.__drizzle_migrations
 *       order by created_at desc limit 1
 *     // then, per journal entry:
 *     if (!last || Number(last.created_at) < migration.folderMillis) { apply }
 *
 * Tags and hashes are stored and never compared. A migration whose `when` sits
 * below the highest already applied is skipped silently and permanently, the
 * job reports success, and the first symptom is a 500 against a column that was
 * never created — in front of a client, days later. That has already happened
 * here once, with two branches each writing an `0019`.
 *
 * So this compares the Drizzle schema the application is built from against
 * `information_schema`, and fails the release if the database is missing
 * anything. It reads catalogue metadata only: no client data is selected, and
 * the connection string is never printed.
 */

import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";

const JOURNAL = "./drizzle/meta/_journal.json";

interface Row {
  table_name: string;
  column_name: string;
}

/** Every table/column pair the application's TypeScript schema declares. */
function expectedColumns(): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>();

  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const config = getTableConfig(exported as PgTable);
    expected.set(
      config.name,
      new Set(config.columns.map((column) => column.name)),
    );
  }

  return expected;
}

async function main() {
  const url = process.env.DATABASE_URL;
  const usePglite = !url || !/^postgres(ql)?:\/\//.test(url);

  // Same driver choice as `scripts/migrate.ts`, for the same reason: this must
  // inspect the database the migration just touched, not a different one.
  const query = await (async (): Promise<
    (sql: string) => Promise<Record<string, unknown>[]>
  > => {
    if (usePglite) {
      const dataDir = process.env.PGLITE_DATA_DIR ?? "./.pglite";
      const { PGlite } = await import("@electric-sql/pglite");
      const client = new PGlite(dataDir);
      return async (sql) => (await client.query(sql)).rows as Record<string, unknown>[];
    }

    const { neon } = await import("@neondatabase/serverless");
    // `neon()` is a tagged template by default; `.query()` is the form that
    // takes a plain string. Every query below is a fixed literal with no
    // interpolation, so there is nothing here for a parameter to protect.
    const sql = neon(url!);
    return async (text) =>
      (await sql.query(text, [])) as unknown as Record<string, unknown>[];
  })();

  // ------------------------------------------------------------- the ledger
  const applied = (await query(
    "select created_at from drizzle.__drizzle_migrations order by created_at asc",
  )) as { created_at: string | number }[];

  const marks = applied.map((row) => Number(row.created_at));
  const highWater = marks.length ? marks[marks.length - 1] : null;

  console.log(`Migration ledger: ${marks.length} applied.`);
  console.log(`  high-water mark: ${highWater ?? "(empty database)"}`);
  console.log(`  last five marks: ${marks.slice(-5).join(", ") || "(none)"}`);

  // ---------------------------------------------------- every journal entry
  // The direct form of the check. Whatever the schema happens to declare, a
  // migration listed in the journal and absent from the ledger did not run,
  // and the high-water mark means it never will.
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const ledger = new Set(marks);
  const unapplied = journal.entries.filter((entry) => !ledger.has(entry.when));

  console.log(`\nJournal: ${journal.entries.length} migrations.`);
  if (unapplied.length) {
    console.error("\nMigrations in the journal the database never applied:");
    for (const entry of unapplied) {
      console.error(`  ${entry.tag} (when ${entry.when})`);
    }
    console.error(
      "\nEach of these has a `when` at or below the high-water mark above, so" +
        "\nre-running the migration will not pick them up. They need a new" +
        "\nmigration with a higher `when`.",
    );
    process.exit(1);
  }
  console.log("Every journal entry appears in the ledger.");

  // ------------------------------------------------------------- the schema
  const rows = (await query(
    "select table_name, column_name from information_schema.columns where table_schema = 'public'",
  )) as unknown as Row[];

  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!actual.has(row.table_name)) actual.set(row.table_name, new Set());
    actual.get(row.table_name)!.add(row.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];

  for (const [table, columns] of expectedColumns()) {
    const present = actual.get(table);
    if (!present) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  const tableCount = expectedColumns().size;
  console.log(`\nChecked ${tableCount} tables declared by the application schema.`);

  if (missingTables.length === 0 && missingColumns.length === 0) {
    console.log("Every declared table and column exists in the database.");
    return;
  }

  // Deliberately loud. This is the failure the high-water mark produces, and
  // it is worth stopping a release for: the alternative is finding out from a
  // client.
  console.error("\nThe database does not match the schema this build expects.");
  if (missingTables.length) {
    console.error(`  missing tables:  ${missingTables.sort().join(", ")}`);
  }
  if (missingColumns.length) {
    console.error(`  missing columns: ${missingColumns.sort().join(", ")}`);
  }
  console.error(
    "\nMost likely a migration was skipped because its journal `when` is below" +
      "\nthe high-water mark above. The fix is a new migration with a higher" +
      "\n`when` — editing or renumbering the applied one changes nothing.",
  );
  process.exit(1);
}

main().catch((error) => {
  console.error("Schema verification failed:", error);
  process.exit(1);
});
