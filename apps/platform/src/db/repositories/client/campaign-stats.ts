import { and, count, desc, eq, gte, max, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { campaigns, campaignScans, type ScanDevice } from "@/db/schema";
import { zonedDayStart } from "@/lib/analytics/filters";
import { businessTimeZone } from "@/lib/time";
import type { TenantContext } from "../context";

/**
 * Scan counts, from the portal's own table.
 *
 * Unlike the website figures, these are recorded here, so a day with no
 * scans really is zero scans and the series is filled with zeroes. What
 * the dashboard must not do is draw that series before anything has been
 * scanned at all: thirty flat days on a new campaign reads as "the door
 * hangers failed" when the truth is "they have not gone out yet". So the
 * result carries `allTime` and `hasScansInWindow`, and the page decides.
 */

export interface Breakdown {
  label: string;
  value: number;
}

export interface DayCount {
  /** `YYYY-MM-DD` in the business's timezone. */
  date: string;
  scans: number;
}

export interface ScanStats {
  days: number;
  /** Every counted scan in scope, ever. Zero means nothing has been scanned yet. */
  allTime: number;
  total: number;
  hasScansInWindow: boolean;
  series: DayCount[];
  byCampaign: Array<{ publicId: string; name: string; scans: number }>;
  byDevice: Breakdown[];
  byTown: Breakdown[];
}

const DEVICE_LABELS: Record<ScanDevice, string> = {
  mobile: "Phone",
  tablet: "Tablet",
  desktop: "Computer",
  unknown: "Not known",
};

const MAX_TOWNS = 8;

/** The local dates in the window, oldest first, ending today. */
export function windowDates(days: number, now: Date, timeZone: string): string[] {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const [year, month, day] = today.split("-").map(Number);
  return Array.from({ length: days }, (_, i) =>
    new Date(Date.UTC(year!, month! - 1, day! - (days - 1 - i))).toISOString().slice(0, 10),
  );
}

function windowStart(dates: string[], timeZone: string): Date {
  return new Date(zonedDayStart(dates[0]!, timeZone));
}

/**
 * The scan's local date, as SQL.
 *
 * The zone is inlined rather than bound: the same expression appears in the
 * select list and is grouped by position, and Postgres treats two bound
 * parameters as two different expressions. It is checked against the shape
 * of an IANA name first, so nothing else can reach the statement.
 */
function localDay(timeZone: string): SQL<string> {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) {
    throw new Error(`Not a timezone name: ${timeZone}`);
  }
  return sql<string>`to_char(${campaignScans.scannedAt} at time zone '${sql.raw(timeZone)}', 'YYYY-MM-DD')`;
}

function townLabel(row: { city: string | null; region: string | null; country: string | null }): string {
  if (!row.city) return "Place not known";
  if (row.country === "US" && row.region) return `${row.city}, ${row.region}`;
  return row.country ? `${row.city}, ${row.country}` : row.city;
}

function byValue(a: Breakdown, b: Breakdown): number {
  return b.value - a.value || a.label.localeCompare(b.label);
}

export async function campaignStats(
  db: Database,
  ctx: TenantContext,
  {
    days = 30,
    now = new Date(),
    campaignPublicId,
  }: { days?: number; now?: Date; campaignPublicId?: string } = {},
): Promise<ScanStats> {
  const timeZone = businessTimeZone();
  const dates = windowDates(days, now, timeZone);
  const start = windowStart(dates, timeZone);

  let scope: SQL | undefined = eq(campaignScans.organizationId, ctx.organizationId);
  if (campaignPublicId) {
    const [campaign] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.publicId, campaignPublicId), eq(campaigns.organizationId, ctx.organizationId)))
      .limit(1);
    // Another tenant's id reads as an empty campaign, never as theirs.
    if (!campaign) return emptyStats(dates);
    scope = and(scope, eq(campaignScans.campaignId, campaign.id));
  }
  const inWindow = and(scope, gte(campaignScans.scannedAt, start));
  const day = localDay(timeZone);

  const [allTime, perDay, devices, towns] = await Promise.all([
    db.select({ n: count() }).from(campaignScans).where(scope),
    db
      .select({ publicId: campaigns.publicId, name: campaigns.name, day, n: count() })
      .from(campaignScans)
      .innerJoin(campaigns, eq(campaigns.id, campaignScans.campaignId))
      .where(inWindow)
      .groupBy(sql`1, 2, 3`),
    db
      .select({ device: campaignScans.device, n: count() })
      .from(campaignScans)
      .where(inWindow)
      .groupBy(campaignScans.device),
    db
      .select({ city: campaignScans.city, region: campaignScans.region, country: campaignScans.country, n: count() })
      .from(campaignScans)
      .where(inWindow)
      .groupBy(campaignScans.city, campaignScans.region, campaignScans.country),
  ]);

  const perDate = new Map<string, number>();
  const perCampaign = new Map<string, { publicId: string; name: string; scans: number }>();
  for (const row of perDay) {
    perDate.set(row.day, (perDate.get(row.day) ?? 0) + row.n);
    const entry = perCampaign.get(row.publicId) ?? { publicId: row.publicId, name: row.name, scans: 0 };
    perCampaign.set(row.publicId, { ...entry, scans: entry.scans + row.n });
  }
  const total = perDay.reduce((sum, row) => sum + row.n, 0);

  const townRows = towns.map((row) => ({ label: townLabel(row), value: row.n })).sort(byValue);
  const shownTowns = townRows.slice(0, MAX_TOWNS);
  const elsewhere = townRows.slice(MAX_TOWNS).reduce((sum, row) => sum + row.value, 0);

  return {
    days,
    allTime: allTime[0]?.n ?? 0,
    total,
    hasScansInWindow: total > 0,
    series: dates.map((date) => ({ date, scans: perDate.get(date) ?? 0 })),
    byCampaign: [...perCampaign.values()].sort(
      (a, b) => b.scans - a.scans || a.name.localeCompare(b.name),
    ),
    byDevice: devices
      .map((row) => ({ label: DEVICE_LABELS[row.device as ScanDevice] ?? "Not known", value: row.n }))
      .sort(byValue),
    byTown: elsewhere > 0 ? [...shownTowns, { label: "Elsewhere", value: elsewhere }] : shownTowns,
  };
}

function emptyStats(dates: string[]): ScanStats {
  return {
    days: dates.length,
    allTime: 0,
    total: 0,
    hasScansInWindow: false,
    series: dates.map((date) => ({ date, scans: 0 })),
    byCampaign: [],
    byDevice: [],
    byTown: [],
  };
}

export interface CampaignCounts {
  inWindow: number;
  total: number;
  lastScanAt: Date | null;
  daily: number[];
}

/** Per-campaign counts for one organization, keyed by campaign id. */
export async function scanCountsByCampaign(
  db: Database,
  organizationId: string,
  { days, now }: { days: number; now: Date },
): Promise<Map<string, CampaignCounts>> {
  const timeZone = businessTimeZone();
  const dates = windowDates(days, now, timeZone);
  const start = windowStart(dates, timeZone);

  const [totals, perDay] = await Promise.all([
    db
      .select({ campaignId: campaignScans.campaignId, n: count(), last: max(campaignScans.scannedAt) })
      .from(campaignScans)
      .where(eq(campaignScans.organizationId, organizationId))
      .groupBy(campaignScans.campaignId)
      .orderBy(desc(count())),
    db
      .select({ campaignId: campaignScans.campaignId, day: localDay(timeZone), n: count() })
      .from(campaignScans)
      .where(and(eq(campaignScans.organizationId, organizationId), gte(campaignScans.scannedAt, start)))
      .groupBy(sql`1, 2`),
  ]);

  const index = new Map(dates.map((date, i) => [date, i]));
  const result = new Map<string, CampaignCounts>();
  for (const row of totals) {
    result.set(row.campaignId, {
      inWindow: 0,
      total: row.n,
      lastScanAt: row.last ? new Date(row.last) : null,
      daily: new Array<number>(days).fill(0),
    });
  }
  for (const row of perDay) {
    const entry = result.get(row.campaignId);
    const at = index.get(row.day);
    if (!entry || at === undefined) continue;
    const daily = entry.daily.map((n, i) => (i === at ? n + row.n : n));
    result.set(row.campaignId, { ...entry, inWindow: entry.inWindow + row.n, daily });
  }
  return result;
}
