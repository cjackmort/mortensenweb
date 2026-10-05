import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { businessProfiles, organizations } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The general-information table, against the real migration chain.
 *
 * Shipped ahead of the code that uses it, so what is worth pinning is the
 * shape that code relies on: one profile per organization, and `details`
 * always a JSON object.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

async function org() {
  return (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: "Acme", slug: `acme-${newPublicId().slice(0, 6).toLowerCase()}`, kind: "client" })
      .returning()
  )[0]!;
}

describe("business_profiles", () => {
  it("holds one profile per organization", async () => {
    const { id } = await org();
    await db.insert(businessProfiles).values({ organizationId: id, details: { phone: "208-555-0100" } });

    await expect(
      db.insert(businessProfiles).values({ organizationId: id, details: {} }),
    ).rejects.toThrow();
  });

  it("refuses details that are not an object", async () => {
    const { id } = await org();
    await expect(
      db.execute(sql`insert into business_profiles (organization_id, details) values (${id}, '[]'::jsonb)`),
    ).rejects.toThrow();
  });

  it("goes when the organization does", async () => {
    const { id } = await org();
    await db.insert(businessProfiles).values({ organizationId: id, details: {} });
    await db.execute(sql`delete from organizations where id = ${id}`);

    const left = await db.execute(sql`select count(*)::int as n from business_profiles where organization_id = ${id}`);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});
