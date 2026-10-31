import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { changeRequests } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * 0048_request_size.sql, replayed one statement at a time the way Neon's HTTP
 * driver runs it.
 *
 * Additive: a new enum and a nullable column, nothing backfilled. A request
 * from before D7 has no size, and the migration must not guess one.
 *
 * Reads and writes of `size` go through raw SQL so this file holds without the
 * column in the TypeScript schema, which ships in the code release after this
 * one.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

const MIGRATION = readFileSync("./drizzle/0048_request_size.sql", "utf8");

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

async function addRequest(): Promise<string> {
  const [row] = await db
    .insert(changeRequests)
    .values({ publicId: newPublicId(), organizationId: acme.organizationId, title: "Change the phone number" })
    .returning({ id: changeRequests.id });
  return row!.id;
}

async function sizeOf(id: string): Promise<string | null> {
  const [row] = rowsOf<{ size: string | null }>(await db.execute(sql`select size from change_requests where id = ${id}`));
  return row!.size;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
});

afterAll(async () => {
  await close();
});

describe("0048_request_size", () => {
  it("adds small and big, and nothing else", async () => {
    const values = rowsOf<{ value: string }>(
      await db.execute(sql`select unnest(enum_range(null::request_size))::text as value`),
    ).map((r) => r.value);
    expect(values).toEqual(["small", "big"]);
  });

  it("leaves a request without a size unsized rather than guessing", async () => {
    const id = await addRequest();
    expect(await sizeOf(id)).toBeNull();
  });

  it("stores a size, and refuses anything that is not one", async () => {
    const id = await addRequest();
    await db.execute(sql`update change_requests set size = 'small' where id = ${id}`);
    expect(await sizeOf(id)).toBe("small");
    await expect(db.execute(sql`update change_requests set size = 'medium' where id = ${id}`)).rejects.toThrow();
  });

  it("changes nothing when run a second time", async () => {
    const id = await addRequest();
    await db.execute(sql`update change_requests set size = 'big' where id = ${id}`);

    await replay();
    await replay();

    expect(await sizeOf(id)).toBe("big");
  });
});
