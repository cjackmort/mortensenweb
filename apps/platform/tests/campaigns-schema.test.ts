import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { campaigns, campaignScans, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Migration 0030 on its own: the tables exist as the TypeScript schema
 * declares them, and the database refuses the rows the application must
 * never write — whatever code path tries.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let siteId: string;

function campaignRow(overrides: Partial<typeof campaigns.$inferInsert> = {}) {
  return {
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    siteId,
    code: `c${newPublicId().slice(0, 7).toLowerCase()}`,
    name: "Spring door hangers",
    placement: "door_hangers",
    utmCampaign: `spring-${newPublicId().slice(0, 6).toLowerCase()}`,
    ...overrides,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: acme.organizationId, name: "acme" })
    .returning({ id: sites.id });
  siteId = site!.id;
});

afterAll(async () => {
  await close();
});

describe("campaigns table", () => {
  it("stores a campaign with the home page as its default destination", async () => {
    const [row] = await db.insert(campaigns).values(campaignRow()).returning();
    expect(row!.destinationPath).toBe("/");
    expect(row!.pausedAt).toBeNull();
  });

  it("refuses a placement the portal does not offer", async () => {
    await expect(db.insert(campaigns).values(campaignRow({ placement: "billboard" }))).rejects.toThrow();
  });

  it("refuses a code that is not short lower-case letters and digits", async () => {
    await expect(db.insert(campaigns).values(campaignRow({ code: "Has-Caps" }))).rejects.toThrow();
    await expect(db.insert(campaigns).values(campaignRow({ code: "abc" }))).rejects.toThrow();
  });

  it("refuses a destination that is a full URL rather than a path", async () => {
    await expect(
      db.insert(campaigns).values(campaignRow({ destinationPath: "https://elsewhere.example/" })),
    ).rejects.toThrow();
  });

  it("refuses a second campaign with the same code", async () => {
    await db.insert(campaigns).values(campaignRow({ code: "samecode" }));
    await expect(db.insert(campaigns).values(campaignRow({ code: "samecode" }))).rejects.toThrow();
  });

  it("refuses two campaigns in one organization sharing a utm_campaign", async () => {
    await db.insert(campaigns).values(campaignRow({ utmCampaign: "yard-signs" }));
    await expect(db.insert(campaigns).values(campaignRow({ utmCampaign: "yard-signs" }))).rejects.toThrow();
  });
});

describe("campaign_scans table", () => {
  it("records a scan and refuses an unknown device class", async () => {
    const [campaign] = await db.insert(campaigns).values(campaignRow()).returning({ id: campaigns.id });
    await db.insert(campaignScans).values({
      campaignId: campaign!.id,
      organizationId: acme.organizationId,
      device: "mobile",
      city: "Riverton",
      region: "UT",
      country: "US",
    });
    const rows = await db.select().from(campaignScans).where(eq(campaignScans.campaignId, campaign!.id));
    expect(rows).toHaveLength(1);

    await expect(
      db.insert(campaignScans).values({
        campaignId: campaign!.id,
        organizationId: acme.organizationId,
        device: "smart-fridge",
      }),
    ).rejects.toThrow();
  });
});
