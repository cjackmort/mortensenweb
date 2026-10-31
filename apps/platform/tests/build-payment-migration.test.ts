import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * 0047_build_payment.sql, replayed one statement at a time the way Neon's HTTP
 * driver runs it.
 *
 * The carry-over: a client the old rule had already unlocked is a client whose
 * site was "paid for" by that rule, so `build_paid_at` starts at the unlock
 * time, with one audit row saying it came from the migration. A client never
 * unlocked owes the build and stays null.
 *
 * Reads and writes of `build_paid_at` go through raw SQL so this file holds
 * without the column in the TypeScript schema, which ships in the code release
 * after this one.
 */

let db: Database;
let close: () => Promise<void>;
let unlocked: SeededTenant;
let locked: SeededTenant;
let alreadyPaid: SeededTenant;

const MIGRATION = readFileSync("./drizzle/0047_build_payment.sql", "utf8");
const UNLOCKED_AT = new Date("2026-09-14T17:30:00Z");
const PAID_AT = new Date("2026-10-02T09:00:00Z");

function statements(source: string): string[] {
  return source
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

async function replay(): Promise<void> {
  for (const statement of statements(MIGRATION)) {
    await db.execute(sql.raw(statement));
  }
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

async function buildPaidAt(clientId: string): Promise<Date | null> {
  const [row] = rowsOf<{ build_paid_at: Date | string | null }>(
    await db.execute(sql`select build_paid_at from clients where id = ${clientId}`),
  );
  return row!.build_paid_at === null ? null : new Date(row!.build_paid_at);
}

async function carryOverRows(): Promise<Array<{ entity_id: string; source: string; at: string }>> {
  return rowsOf(
    await db.execute(sql`
      select entity_id, metadata->>'source' as source, metadata->>'at' as at
      from audit_log where action = 'build.paid' order by entity_id`),
  );
}

async function publicIdOf(clientId: string): Promise<string> {
  const [row] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, clientId));
  return row!.publicId;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  unlocked = await seedTenant(db, "Unlocked");
  locked = await seedTenant(db, "Locked");
  alreadyPaid = await seedTenant(db, "Already Paid");

  // The state production is in before 0047 runs: unlock timestamps from the
  // old any-payment rule, and no `build_paid_at` anywhere.
  await db.update(clients).set({ changeRequestsUnlockedAt: UNLOCKED_AT }).where(eq(clients.id, unlocked.clientId));
  await db.update(clients).set({ changeRequestsUnlockedAt: UNLOCKED_AT }).where(eq(clients.id, alreadyPaid.clientId));
  await db.execute(sql`update clients set build_paid_at = null`);
  await db.execute(sql`delete from audit_log where action = 'build.paid'`);
  // Except one the new code already marked, which the migration must leave be.
  await db.execute(sql`update clients set build_paid_at = ${PAID_AT.toISOString()} where id = ${alreadyPaid.clientId}`);
});

afterAll(async () => {
  await close();
});

describe("0047_build_payment", () => {
  it("adds `build` to what an invoice can be for", async () => {
    const values = rowsOf<{ value: string }>(
      await db.execute(sql`select unnest(enum_range(null::payment_purpose))::text as value`),
    ).map((r) => r.value);
    expect(values).toContain("build");
  });

  it("carries an earlier unlock over as the build paid, at the unlock time", async () => {
    await replay();
    expect(await buildPaidAt(unlocked.clientId)).toEqual(UNLOCKED_AT);
  });

  it("leaves a client who was never unlocked owing the build", async () => {
    expect(await buildPaidAt(locked.clientId)).toBeNull();
  });

  it("leaves a build already marked paid at its own time", async () => {
    expect(await buildPaidAt(alreadyPaid.clientId)).toEqual(PAID_AT);
  });

  it("records each carry-over once, naming the migration", async () => {
    const rows = await carryOverRows();
    expect(rows).toEqual([
      { entity_id: await publicIdOf(unlocked.clientId), source: "migration_0047", at: expect.any(String) },
    ]);
    expect(new Date(rows[0]!.at)).toEqual(UNLOCKED_AT);
  });

  it("changes nothing when run a second time", async () => {
    await replay();
    expect(await carryOverRows()).toHaveLength(1);
    expect(await buildPaidAt(unlocked.clientId)).toEqual(UNLOCKED_AT);
    expect(await buildPaidAt(locked.clientId)).toBeNull();
  });
});
