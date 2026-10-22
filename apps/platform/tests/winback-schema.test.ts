import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  winbackCampaigns,
  winbackContacts,
  winbackRecipients,
  winbackSuppressions,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The win-back tables, against the real migration chain.
 *
 * Shipped ahead of the code that uses them, so what is pinned here is the
 * shape that code relies on: one contact per address, one copy of a campaign
 * per address, one suppression per address, and states that cannot drift.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  acme = await seedTenant(db, "Acme Heating");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => close());

async function campaign(organizationId: string) {
  const [row] = await db
    .insert(winbackCampaigns)
    .values({
      publicId: newPublicId(),
      organizationId,
      occasionKey: "custom",
      name: "Fall",
      subject: "Time for a furnace check",
      body: "Hi {first_name},",
    })
    .returning();
  return row!;
}

describe("winback_contacts", () => {
  it("holds one contact per address per organization", async () => {
    const values = {
      organizationId: acme.organizationId,
      email: "dana@example.test",
      source: "import",
      howBecameCustomer: "Imported from customers.csv",
    };
    await db.insert(winbackContacts).values({ publicId: newPublicId(), ...values });
    await expect(
      db.insert(winbackContacts).values({ publicId: newPublicId(), ...values }),
    ).rejects.toThrow();

    // The same address is a different contact in another business.
    await db
      .insert(winbackContacts)
      .values({ publicId: newPublicId(), ...values, organizationId: globex.organizationId });
  });

  it("refuses a source it does not know", async () => {
    await expect(
      db.insert(winbackContacts).values({
        publicId: newPublicId(),
        organizationId: acme.organizationId,
        email: "x@example.test",
        source: "scraped",
        howBecameCustomer: "?",
      }),
    ).rejects.toThrow();
  });
});

describe("winback_campaigns", () => {
  it("starts as a draft", async () => {
    const row = await campaign(acme.organizationId);
    expect(row.status).toBe("draft");
    expect(row.approvedAt).toBeNull();
  });

  it("refuses a status it does not know", async () => {
    const row = await campaign(acme.organizationId);
    await expect(
      db.execute(sql`update winback_campaigns set status = 'queued' where id = ${row.id}`),
    ).rejects.toThrow();
  });
});

describe("winback_recipients", () => {
  it("holds one copy of a campaign per address", async () => {
    const row = await campaign(acme.organizationId);
    const values = { campaignId: row.id, organizationId: acme.organizationId, email: "dana@example.test" };
    const [first] = await db
      .insert(winbackRecipients)
      .values({ publicId: newPublicId(), ...values })
      .returning();
    expect(first!.status).toBe("pending");
    expect(first!.attempts).toBe(0);
    await expect(
      db.insert(winbackRecipients).values({ publicId: newPublicId(), ...values }),
    ).rejects.toThrow();
  });

  it("goes with its campaign", async () => {
    const row = await campaign(acme.organizationId);
    await db
      .insert(winbackRecipients)
      .values({ publicId: newPublicId(), campaignId: row.id, organizationId: acme.organizationId, email: "a@example.test" });
    await db.execute(sql`delete from winback_campaigns where id = ${row.id}`);
    const left = await db.execute(sql`select count(*)::int as n from winback_recipients where campaign_id = ${row.id}`);
    expect((left as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });
});

describe("winback_suppressions", () => {
  it("holds one suppression per address per organization", async () => {
    const values = { organizationId: acme.organizationId, email: "gone@example.test", reason: "unsubscribed" };
    await db.insert(winbackSuppressions).values(values);
    await expect(db.insert(winbackSuppressions).values(values)).rejects.toThrow();
  });

  it("refuses a reason it does not know", async () => {
    await expect(
      db.insert(winbackSuppressions).values({
        organizationId: acme.organizationId,
        email: "who@example.test",
        reason: "annoyed",
      }),
    ).rejects.toThrow();
  });
});
