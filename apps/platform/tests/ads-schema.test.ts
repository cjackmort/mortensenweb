import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { adCampaignChannels, adCampaigns, adStatsDaily } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The ads tables, as the hand-written 0029 migration creates them.
 *
 * `drizzle-kit generate` cannot run on this repository, so nothing checks the
 * SQL against the TypeScript schema except a test that writes through one and
 * reads through the other. The constraints matter most: they are what stop a
 * typo'd status or a negative refund from being stored by any code path.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme Plumbing");
});

afterAll(async () => {
  await close();
});

async function insertCampaign(values: Partial<typeof adCampaigns.$inferInsert> = {}) {
  const rows = await db
    .insert(adCampaigns)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      clientId: acme.clientId,
      name: "Spring drain cleaning",
      ...values,
    })
    .returning();
  return rows[0]!;
}

describe("ad_campaigns", () => {
  it("defaults a new campaign to an empty draft with no money attached", async () => {
    const campaign = await insertCampaign();

    expect(campaign.status).toBe("draft");
    expect(campaign.headlines).toEqual([]);
    expect(campaign.descriptions).toEqual([]);
    expect(campaign.targetAreas).toEqual([]);
    expect(campaign.spendBudgetCents).toBe(0);
    expect(campaign.managementFeeCents).toBe(0);
    expect(campaign.refundedCents).toBe(0);
    expect(campaign.paymentRequestId).toBeNull();
  });

  it("round-trips the creative as arrays", async () => {
    const campaign = await insertCampaign({
      headlines: ["Acme Plumbing", "Drain Cleaning in Riverton"],
      descriptions: ["Call Acme Plumbing for drain cleaning in Riverton."],
      targetAreas: ["Riverton", "South Jordan"],
    });

    const [read] = await db.select().from(adCampaigns).where(eq(adCampaigns.id, campaign.id));
    expect(read!.headlines).toEqual(["Acme Plumbing", "Drain Cleaning in Riverton"]);
    expect(read!.targetAreas).toEqual(["Riverton", "South Jordan"]);
  });

  it("refuses a status it does not know", async () => {
    await expect(insertCampaign({ status: "launched" })).rejects.toThrow();
  });

  it("refuses a negative refund", async () => {
    await expect(insertCampaign({ refundedCents: -100 })).rejects.toThrow();
  });

  it("refuses an end date before the start", async () => {
    await expect(insertCampaign({ startsOn: "2026-11-10", endsOn: "2026-11-01" })).rejects.toThrow();
  });

  it("refuses headlines stored as anything but an array", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO ad_campaigns (public_id, organization_id, client_id, name, headlines)
        VALUES (${newPublicId()}, ${acme.organizationId}, ${acme.clientId}, 'x', '"one"'::jsonb)
      `),
    ).rejects.toThrow();
  });
});

describe("ad_campaign_channels", () => {
  it("allows each channel once per campaign", async () => {
    const campaign = await insertCampaign();
    await db.insert(adCampaignChannels).values({
      campaignId: campaign.id,
      channel: "google_search",
      platform: "google_ads",
      budgetCents: 30000,
    });

    await expect(
      db.insert(adCampaignChannels).values({
        campaignId: campaign.id,
        channel: "google_search",
        platform: "google_ads",
        budgetCents: 10000,
      }),
    ).rejects.toThrow();
  });

  it("refuses a channel or platform it does not know", async () => {
    const campaign = await insertCampaign();
    await expect(
      db.insert(adCampaignChannels).values({
        campaignId: campaign.id,
        channel: "tiktok",
        platform: "meta",
        budgetCents: 10000,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(adCampaignChannels).values({
        campaignId: campaign.id,
        channel: "facebook",
        platform: "facebook",
        budgetCents: 10000,
      }),
    ).rejects.toThrow();
  });
});

describe("ad_stats_daily", () => {
  it("keeps one row per channel, day and breakdown, so a re-sync replaces the day", async () => {
    const campaign = await insertCampaign();
    const [channel] = await db
      .insert(adCampaignChannels)
      .values({ campaignId: campaign.id, channel: "facebook", platform: "meta", budgetCents: 20000 })
      .returning();

    const row = {
      organizationId: acme.organizationId,
      campaignId: campaign.id,
      channelId: channel!.id,
      day: "2026-11-02",
      dimension: "placement",
      dimensionValue: "instagram_reels",
    };

    await db.insert(adStatsDaily).values({ ...row, impressions: 100, clicks: 3, costMicros: 1_250_000 });
    await db
      .insert(adStatsDaily)
      .values({ ...row, impressions: 140, clicks: 4, costMicros: 1_500_000, conversions: 0.5 })
      .onConflictDoUpdate({
        target: [
          adStatsDaily.channelId,
          adStatsDaily.day,
          adStatsDaily.dimension,
          adStatsDaily.dimensionValue,
        ],
        set: { impressions: 140, clicks: 4, costMicros: 1_500_000, conversions: 0.5 },
      });

    const rows = await db.select().from(adStatsDaily).where(eq(adStatsDaily.channelId, channel!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ impressions: 140, clicks: 4, costMicros: 1_500_000, conversions: 0.5 });
  });

  it("refuses a breakdown it does not know", async () => {
    const campaign = await insertCampaign();
    const [channel] = await db
      .insert(adCampaignChannels)
      .values({ campaignId: campaign.id, channel: "instagram", platform: "meta", budgetCents: 20000 })
      .returning();

    await expect(
      db.insert(adStatsDaily).values({
        organizationId: acme.organizationId,
        campaignId: campaign.id,
        channelId: channel!.id,
        day: "2026-11-02",
        dimension: "device",
      }),
    ).rejects.toThrow();
  });

  it("goes when its campaign is deleted", async () => {
    const campaign = await insertCampaign();
    const [channel] = await db
      .insert(adCampaignChannels)
      .values({ campaignId: campaign.id, channel: "google_maps", platform: "google_ads", budgetCents: 15000 })
      .returning();
    await db.insert(adStatsDaily).values({
      organizationId: acme.organizationId,
      campaignId: campaign.id,
      channelId: channel!.id,
      day: "2026-11-02",
      dimension: "total",
    });

    await db.delete(adCampaigns).where(eq(adCampaigns.id, campaign.id));

    const left = await db.select().from(adStatsDaily).where(eq(adStatsDaily.campaignId, campaign.id));
    expect(left).toHaveLength(0);
  });
});
