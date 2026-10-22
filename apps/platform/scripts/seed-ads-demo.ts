/**
 * Demo ads data for a local preview: `npm run db:seed:ads`, after `db:seed`.
 *
 * Gives the seeded demo client (Northwind, an `is_demo` organization on a
 * reserved `.example` domain) a business profile and four paid campaigns, one
 * in each state the operator and the client need to see:
 *
 *  - running, with two weeks of results across Google Search, Google Maps,
 *    Facebook and Instagram, broken down by placement and by place
 *  - running in manual mode with nothing synced: the "not connected" state
 *  - paid and waiting for review, with a claim the profile does not make
 *  - ended and waiting to be settled
 *
 * Refuses anything but the local PGlite database. The figures are invented
 * and deterministic, which is right for a preview and wrong anywhere else.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb, isPgliteMode } from "../src/db/client";
import {
  adCampaignChannels,
  adCampaigns,
  adStatsDaily,
  businessProfiles,
  clients,
  organizations,
  paymentRequests,
  payments,
  users,
} from "../src/db/schema";
import { newPublicId } from "../src/lib/ids";
import { businessDate } from "../src/lib/billing/period";
import { addDays } from "../src/lib/ads/dates";

if (!isPgliteMode()) {
  console.error("Refusing to seed demo ads: DATABASE_URL points at a real database.");
  process.exit(1);
}

/** A small deterministic generator, so every preview shows the same figures. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const PROFILE = {
  businessName: "Northwind Comfort Systems",
  tagline: "Heating and cooling for homes in the south valley",
  services: "Furnace repair\nAC installation\nDuct cleaning\nThermostat installation",
  serviceArea: "Riverton, South Jordan, Herriman and West Jordan",
  phone: "(801) 555-0100",
  website: "https://northwind-demo.example",
};

const CREATIVE = {
  headlines: ["Northwind Comfort Systems", "Furnace Repair in Riverton", "AC Installation in Riverton", "Serving Riverton & South Jordan", "Call Today"],
  descriptions: [
    "Heating and cooling for homes in the south valley.",
    "Furnace repair, AC installation and duct cleaning in Riverton, South Jordan and Herriman.",
  ],
  callToAction: "call",
  finalUrl: "https://northwind-demo.example",
  phone: "(801) 555-0100",
  targetAreas: ["Riverton", "South Jordan", "Herriman", "West Jordan"],
};

type Channel = "google_search" | "google_maps" | "youtube_display" | "facebook" | "instagram";

interface DayShape {
  impressions: [number, number];
  ctr: [number, number];
  cpcMicros: [number, number];
  calls?: number;
  leads?: number;
  placements: Array<[string, number]>;
  places: Array<[string, number]>;
}

const GOOGLE_TOWNS: Array<[string, number]> = [
  ["Riverton, Utah", 0.34],
  ["South Jordan, Utah", 0.24],
  ["Herriman, Utah", 0.17],
  ["West Jordan, Utah", 0.13],
  ["Bluffdale, Utah", 0.06],
  ["Draper, Utah", 0.04],
];
const META_REGIONS: Array<[string, number]> = [
  ["Utah", 0.96],
  ["Idaho", 0.03],
];

const SHAPES: Record<Channel, DayShape> = {
  google_search: {
    impressions: [170, 260],
    ctr: [0.045, 0.07],
    cpcMicros: [700_000, 950_000],
    calls: 0.6,
    placements: [
      ["google_search", 0.86],
      ["search_partners", 0.14],
    ],
    places: GOOGLE_TOWNS,
  },
  google_maps: {
    impressions: [110, 190],
    ctr: [0.03, 0.05],
    cpcMicros: [900_000, 1_200_000],
    calls: 0.4,
    placements: [
      ["google_maps", 0.82],
      ["google_search", 0.18],
    ],
    places: GOOGLE_TOWNS,
  },
  youtube_display: {
    impressions: [900, 1400],
    ctr: [0.004, 0.008],
    cpcMicros: [600_000, 900_000],
    placements: [
      ["youtube", 0.55],
      ["display_network", 0.45],
    ],
    places: GOOGLE_TOWNS,
  },
  facebook: {
    impressions: [620, 900],
    ctr: [0.009, 0.015],
    cpcMicros: [650_000, 900_000],
    leads: 0.3,
    placements: [
      ["facebook_feed", 0.68],
      ["facebook_stories", 0.12],
      ["messenger", 0.11],
      ["audience_network", 0.09],
    ],
    places: META_REGIONS,
  },
  instagram: {
    impressions: [700, 1100],
    ctr: [0.007, 0.012],
    cpcMicros: [700_000, 950_000],
    placements: [
      ["instagram_feed", 0.42],
      ["instagram_stories", 0.31],
      ["instagram_reels", 0.27],
    ],
    places: META_REGIONS,
  },
};

function between(rand: () => number, [low, high]: [number, number]) {
  return low + rand() * (high - low);
}

function statsFor(channel: Channel, days: string[], seed: number) {
  const rand = random(seed);
  const shape = SHAPES[channel];
  return days.flatMap((day, i) => {
    // A gentle rise over the first week, as a new campaign gathers data.
    const ramp = Math.min(1, 0.55 + i * 0.07);
    const impressions = Math.round(between(rand, shape.impressions) * ramp);
    const clicks = Math.round(impressions * between(rand, shape.ctr));
    const costMicros = Math.round(clicks * between(rand, shape.cpcMicros));
    const calls = shape.calls && rand() < shape.calls ? 1 + Math.round(rand()) : 0;
    const leads = shape.leads && rand() < shape.leads ? 1 : 0;

    const split = (parts: Array<[string, number]>, dimension: "placement" | "location") =>
      parts.map(([value, share]) => ({
        day,
        dimension,
        dimensionValue: value,
        impressions: Math.round(impressions * share),
        clicks: Math.round(clicks * share),
        costMicros: Math.round(costMicros * share),
        calls: 0,
        leads: 0,
        conversions: 0,
      }));

    return [
      { day, dimension: "total", dimensionValue: "", impressions, clicks, costMicros, calls, leads, conversions: calls + leads },
      ...split(shape.placements, "placement"),
      ...split(shape.places, "location"),
    ];
  });
}

async function main() {
  const db = await getDb();

  const [found] = await db
    .select({ organizationId: organizations.id, clientId: clients.id })
    .from(organizations)
    .innerJoin(clients, eq(clients.organizationId, organizations.id))
    .where(and(eq(organizations.isDemo, true), eq(clients.isDemo, true)))
    .limit(1);
  if (!found) {
    console.error("No demo client found. Run `npm run db:seed` first.");
    process.exit(1);
  }
  const demo = found;

  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);

  await db
    .insert(businessProfiles)
    .values({ organizationId: demo.organizationId, details: PROFILE })
    .onConflictDoUpdate({ target: businessProfiles.organizationId, set: { details: PROFILE, updatedAt: new Date() } });

  // Start clean, so running this twice gives the same preview.
  const old = await db
    .select({ id: adCampaigns.id, paymentRequestId: adCampaigns.paymentRequestId })
    .from(adCampaigns)
    .where(eq(adCampaigns.organizationId, demo.organizationId));
  if (old.length) {
    await db.delete(adCampaigns).where(inArray(adCampaigns.id, old.map((c) => c.id)));
  }

  const today = businessDate();

  async function paidCampaign(input: {
    name: string;
    status: string;
    channels: Array<[Channel, number]>;
    startsOn: string;
    days: number;
    launched: boolean;
    endedAt?: Date;
    headlines?: string[];
  }) {
    const spend = input.channels.reduce((n, [, cents]) => n + cents, 0);
    const fee = Math.max(Math.round(spend * 0.15), 2500);
    const [payment] = await db
      .insert(payments)
      .values({
        publicId: newPublicId(),
        clientId: demo.clientId,
        amountCents: spend + fee,
        method: "stripe",
        provider: "stripe",
        providerReference: `pi_demo_${newPublicId().slice(0, 10)}`,
        receivedOn: addDays(input.startsOn, -3),
        isDemo: true,
      })
      .returning();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        publicId: newPublicId(),
        clientId: demo.clientId,
        reference: `MW-${newPublicId().slice(0, 4)}`,
        amountCents: spend + fee,
        status: "paid",
        method: "stripe",
        provider: "stripe",
        purpose: "other",
        note: `Ad campaign: ${input.name}`,
        confirmedAt: new Date(`${addDays(input.startsOn, -3)}T17:00:00Z`),
        confirmedByUserId: admin?.id ?? null,
        paymentId: payment!.id,
        isDemo: true,
      })
      .returning();

    const [campaign] = await db
      .insert(adCampaigns)
      .values({
        publicId: newPublicId(),
        organizationId: demo.organizationId,
        clientId: demo.clientId,
        name: input.name,
        status: input.status,
        ...CREATIVE,
        headlines: input.headlines ?? CREATIVE.headlines,
        draftSource: "template",
        draftFacts: PROFILE,
        startsOn: input.startsOn,
        endsOn: addDays(input.startsOn, input.days - 1),
        paymentRequestId: request!.id,
        spendBudgetCents: spend,
        managementFeeCents: fee,
        feeBasisPoints: 1500,
        feeMinimumCents: 2500,
        paidAt: new Date(`${addDays(input.startsOn, -3)}T17:00:00Z`),
        reviewedAt: input.launched ? new Date(`${addDays(input.startsOn, -1)}T17:00:00Z`) : null,
        reviewedBy: input.launched ? (admin?.id ?? null) : null,
        launchedAt: input.launched ? new Date(`${input.startsOn}T15:00:00Z`) : null,
        endedAt: input.endedAt ?? null,
      })
      .returning();
    return { campaign: campaign!, spend };
  }

  async function addChannels(
    campaignId: string,
    channels: Array<[Channel, number]>,
    { linked, status }: { linked: boolean; status: string },
  ) {
    return db
      .insert(adCampaignChannels)
      .values(
        channels.map(([channel, budgetCents], i) => ({
          campaignId,
          channel,
          platform: channel.startsWith("google") || channel === "youtube_display" ? "google_ads" : "meta",
          budgetCents,
          launchMode: linked ? "manual" : null,
          externalAccountId: linked ? (channel.startsWith("google") ? "4445556666" : "act_1029384756") : null,
          externalCampaignId: linked ? `2219${String(800000 + i * 137).padStart(8, "0")}` : null,
          status,
        })),
      )
      .returning();
  }

  async function addStats(campaignId: string, channels: Array<{ id: string; channel: string }>, days: string[]) {
    const now = new Date();
    for (const [i, channel] of channels.entries()) {
      const rows = statsFor(channel.channel as Channel, days, 7 + i * 31);
      for (let j = 0; j < rows.length; j += 200) {
        await db.insert(adStatsDaily).values(
          rows.slice(j, j + 200).map((r) => ({
            ...r,
            organizationId: demo.organizationId,
            campaignId,
            channelId: channel.id,
            syncedAt: now,
          })),
        );
      }
      const spend = rows.filter((r) => r.dimension === "total").reduce((n, r) => n + r.costMicros, 0);
      await db
        .update(adCampaignChannels)
        .set({ spendMicros: spend, lastSyncedAt: now })
        .where(eq(adCampaignChannels.id, channel.id));
    }
  }

  // 1. Running for two weeks, with results.
  const runningChannels: Array<[Channel, number]> = [
    ["google_search", 30000],
    ["google_maps", 21000],
    ["facebook", 24000],
    ["instagram", 24000],
  ];
  const runningStart = addDays(today, -13);
  const running = await paidCampaign({ name: "Furnace repair ad", status: "active", channels: runningChannels, startsOn: runningStart, days: 30, launched: true });
  const runningRows = await addChannels(running.campaign.id, runningChannels, { linked: true, status: "active" });
  await addStats(
    running.campaign.id,
    runningRows,
    Array.from({ length: 14 }, (_, i) => addDays(runningStart, i)),
  );

  // 2. Running in manual mode, nothing synced: "not connected".
  const manualChannels: Array<[Channel, number]> = [["google_search", 30000]];
  const manual = await paidCampaign({ name: "AC installation ad", status: "active", channels: manualChannels, startsOn: addDays(today, -2), days: 30, launched: true });
  await addChannels(manual.campaign.id, manualChannels, { linked: true, status: "active" });

  // 3. Paid, waiting for review, with a claim the profile never makes.
  const reviewChannels: Array<[Channel, number]> = [
    ["facebook", 15000],
    ["instagram", 15000],
  ];
  const review = await paidCampaign({
    name: "Duct cleaning ad",
    status: "pending_review",
    channels: reviewChannels,
    startsOn: addDays(today, 3),
    days: 30,
    launched: false,
    headlines: ["Northwind Comfort Systems", "Duct Cleaning in Riverton", "Licensed & Insured Techs", "Call Today"],
  });
  await addChannels(review.campaign.id, reviewChannels, { linked: false, status: "pending" });

  // 4. Ended, waiting to be settled: spent less than its budget.
  const endedChannels: Array<[Channel, number]> = [["google_search", 21000]];
  const endedStart = addDays(today, -30);
  const ended = await paidCampaign({
    name: "Thermostat installation ad",
    status: "ended",
    channels: endedChannels,
    startsOn: endedStart,
    days: 14,
    launched: true,
    endedAt: new Date(`${addDays(endedStart, 14)}T07:00:00Z`),
  });
  const endedRows = await addChannels(ended.campaign.id, endedChannels, { linked: true, status: "ended" });
  await addStats(ended.campaign.id, endedRows, Array.from({ length: 14 }, (_, i) => addDays(endedStart, i)));

  console.log(`
Demo ads seeded for Northwind Comfort Systems (DEMO):

  Running, with results     ${running.campaign.publicId}
  Running, not connected    ${manual.campaign.publicId}
  Waiting for review        ${review.campaign.publicId}
  Ended, to settle          ${ended.campaign.publicId}
`);
}

main().catch((error) => {
  console.error("Seeding demo ads failed:", error);
  process.exit(1);
});
