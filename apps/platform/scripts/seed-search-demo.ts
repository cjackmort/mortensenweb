/**
 * Demo Search Console figures for a local preview: `npm run db:seed:search`,
 * after `db:seed`.
 *
 * Gives the seeded demo client (Northwind, an `is_demo` organization on a
 * reserved `.example` domain) a connected Google account with no tokens —
 * the page only reads its status — and 28 days of snapshots, so the Search
 * page shows the headline, the sparklines, the comparison with the earliest
 * snapshot and the table of queries. `--failed` makes today's attempt a
 * failed one, for the "could not read" notice; `--disconnected` removes the
 * connection and every snapshot, for the "connect Google first" state.
 *
 * Refuses anything but the local PGlite database. The figures are invented
 * and deterministic, which is right for a preview and wrong anywhere else.
 */

import { eq } from "drizzle-orm";
import { getDb, isPgliteMode } from "../src/db/client";
import { connectedAccounts, organizations, searchSnapshots, sites } from "../src/db/schema";
import type { SearchSnapshot } from "../src/lib/connections/providers/google";
import { newPublicId } from "../src/lib/ids";

if (!isPgliteMode()) {
  console.error("Refusing to seed demo search figures: DATABASE_URL points at a real database.");
  process.exit(1);
}

const withFailure = process.argv.includes("--failed");
const disconnected = process.argv.includes("--disconnected");
const DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A small deterministic generator, so every preview shows the same figures. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const QUERIES: Array<[string, number, number]> = [
  ["furnace repair riverton", 820, 4.1],
  ["hvac riverton utah", 610, 5.8],
  ["ac installation south jordan", 440, 7.2],
  ["northwind comfort systems", 390, 1.1],
  ["furnace not turning on", 350, 12.4],
  ["duct cleaning herriman", 260, 9.6],
  ["ac repair west jordan", 240, 8.9],
  ["thermostat installation near me", 180, 14.2],
  ["heating and cooling riverton", 160, 6.3],
  ["emergency furnace repair", 120, 11.8],
  ["hvac south jordan", 110, 7.7],
  ["air conditioner tune up", 90, 15.1],
];

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function snapshotFor(takenOn: Date, index: number): SearchSnapshot {
  const rand = random(index + 1);
  const end = new Date(takenOn.getTime() - 2 * DAY_MS);
  const start = new Date(end.getTime() - (DAYS - 1) * DAY_MS);
  // Slowly climbing across the month, so the comparison with the earliest snapshot has something to say.
  const growth = 0.85 + 0.3 * (index / (DAYS - 1));
  const daily = Array.from({ length: DAYS }, (_, i) => {
    const date = new Date(start.getTime() + i * DAY_MS);
    const weekend = [0, 6].includes(date.getUTCDay());
    const impressions = Math.round((weekend ? 70 : 130) * growth * (0.8 + rand() * 0.4));
    const clicks = Math.round(impressions * (0.03 + rand() * 0.02));
    return { date: dateOnly(date), clicks, impressions, position: 5.5 + rand() * 2 - growth };
  });
  const impressions = daily.reduce((s, d) => s + d.impressions, 0);
  const clicks = daily.reduce((s, d) => s + d.clicks, 0);
  const position = daily.reduce((s, d) => s + d.position * d.impressions, 0) / impressions;
  const scale = impressions / 3770;
  return {
    property: "sc-domain:northwind-demo.example",
    properties: ["sc-domain:northwind-demo.example"],
    startDate: dateOnly(start),
    endDate: dateOnly(end),
    totals: { clicks, impressions, ctr: clicks / impressions, position },
    previous: { clicks: Math.round(clicks * 0.88), impressions: Math.round(impressions * 0.91) },
    queries: QUERIES.map(([key, shown, pos]) => {
      const shownNow = Math.round(shown * scale);
      const clicked = Math.round(shownNow * Math.max(0.01, 0.22 - pos * 0.014));
      return { key, clicks: clicked, impressions: shownNow, ctr: clicked / Math.max(1, shownNow), position: pos };
    }),
    pages: [],
    daily,
  };
}

async function main() {
  const db = await getDb();
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, "northwind-comfort-demo"))
    .limit(1);
  if (!org) {
    console.error("The demo client is not seeded. Run `npm run db:seed` first.");
    process.exit(1);
  }
  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.organizationId, org.id)).limit(1);
  if (!site) {
    console.error("The demo client has no site.");
    process.exit(1);
  }

  await db.delete(searchSnapshots).where(eq(searchSnapshots.organizationId, org.id));
  await db.delete(connectedAccounts).where(eq(connectedAccounts.organizationId, org.id));
  if (disconnected) {
    console.log("Removed the demo client's Google connection and search snapshots.");
    return;
  }

  const now = new Date();
  await db.insert(connectedAccounts).values({
    publicId: newPublicId(),
    organizationId: org.id,
    provider: "google",
    externalId: "demo-google-subject",
    displayName: "owner@northwind-demo.example",
    scope: "openid email https://www.googleapis.com/auth/webmasters.readonly",
    status: "connected",
    connectedAt: new Date(now.getTime() - DAYS * DAY_MS),
  });

  for (let i = 0; i < DAYS; i += 1) {
    const takenAt = new Date(now.getTime() - (DAYS - 1 - i) * DAY_MS);
    if (withFailure && i === DAYS - 1) {
      await db.insert(searchSnapshots).values({
        organizationId: org.id,
        siteId: site.id,
        takenOn: dateOnly(takenAt),
        data: null,
        error: "Google 503: Service Unavailable",
        attemptedAt: takenAt,
        fetchedAt: null,
      });
      continue;
    }
    const snapshot = snapshotFor(takenAt, i);
    await db.insert(searchSnapshots).values({
      organizationId: org.id,
      siteId: site.id,
      takenOn: dateOnly(takenAt),
      property: snapshot.property,
      data: snapshot,
      error: null,
      attemptedAt: takenAt,
      fetchedAt: takenAt,
    });
  }

  console.log(`Seeded ${DAYS} days of search snapshots for the demo client${withFailure ? ", the last one failed" : ""}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
