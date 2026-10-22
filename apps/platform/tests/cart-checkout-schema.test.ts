import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { createTestDb } from "./helpers/db";

/**
 * Migration 0038: the columns the cart checkout and the onboarding status
 * read, added before any code that names them.
 *
 * The Drizzle schema deliberately does not declare these yet. Drizzle expands
 * `select().from(clients)` to an explicit column list, so declaring a column
 * the production database lacks turns every client query into a 500 — and
 * Netlify deploys code before the migrate job runs. This PR therefore ships
 * the SQL alone, and the test reads the catalogue rather than the schema.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const result = await db.execute(sql`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  const rows = (result as unknown as { rows: Array<Record<string, string>> }).rows;
  return new Map(
    rows.map((row) => [row.column_name!, { type: row.data_type!, nullable: row.is_nullable === "YES" }]),
  );
}

describe("0038 cart checkout columns", () => {
  it("adds the build, payment and demo columns to clients, all nullable", async () => {
    const found = await columns("clients");
    expect(found.get("build_key")).toEqual({ type: "text", nullable: true });
    expect(found.get("build_price_cents")).toEqual({ type: "integer", nullable: true });
    expect(found.get("build_paid_at")).toEqual({ type: "timestamp with time zone", nullable: true });
    expect(found.get("demo_url")).toEqual({ type: "text", nullable: true });
    expect(found.get("demo_sent_at")).toEqual({ type: "timestamp with time zone", nullable: true });
  });

  it("adds the client-owned domain columns to clients, all nullable", async () => {
    const found = await columns("clients");
    expect(found.get("domain_name")).toEqual({ type: "text", nullable: true });
    expect(found.get("domain_registrar")).toEqual({ type: "text", nullable: true });
    expect(found.get("domain_access_confirmed_at")).toEqual({ type: "timestamp with time zone", nullable: true });
  });

  it("adds cancels_at to client_add_ons, nullable", async () => {
    const found = await columns("client_add_ons");
    expect(found.get("cancels_at")).toEqual({ type: "timestamp with time zone", nullable: true });
  });

  it("refuses a negative build price", async () => {
    await db.execute(sql`
      insert into organizations (public_id, name, slug, kind)
      values ('org_neg', 'Negative', 'negative', 'client')
    `);
    const failure = await db
      .execute(sql`
        insert into clients (public_id, organization_id, build_price_cents)
        select 'cli_neg', id, -1 from organizations where public_id = 'org_neg'
      `)
      .then(() => null, (error: unknown) => error as { cause?: { message?: string } });
    // Drizzle wraps the driver error; the constraint name is on the cause.
    expect(failure?.cause?.message).toMatch(/clients_build_price_non_negative/);
  });

  it("accepts a client with no build set, which is every existing client", async () => {
    await db.execute(sql`
      insert into organizations (public_id, name, slug, kind)
      values ('org_none', 'No build', 'no-build', 'client')
    `);
    await db.execute(sql`
      insert into clients (public_id, organization_id)
      select 'cli_none', id from organizations where public_id = 'org_none'
    `);
    const result = await db.execute(sql`
      select build_key, build_price_cents, build_paid_at from clients where public_id = 'cli_none'
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows[0]).toEqual({ build_key: null, build_price_cents: null, build_paid_at: null });
  });
});
