import type { AdPlatform } from "@mortensenweb/plans";
import { placementFor } from "./placements";
import type { StatDimension } from "./stats";

/**
 * A campaign's report, from its stored daily rows.
 *
 * Totals come from `total` rows only, never from adding up a breakdown: a
 * platform puts a click it could not place on a map in the total and in no
 * location, so summing the locations would undercount, quietly.
 */

export interface StoredStat {
  day: string;
  dimension: StatDimension | string;
  dimensionValue: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  calls: number;
  leads: number;
  conversions: number;
  /** The channel's platform. Locations are kept apart by it: see `ReportLocation`. */
  platform?: AdPlatform | string;
}

export interface ReportTotals {
  impressions: number;
  clicks: number;
  costMicros: number;
  calls: number;
  leads: number;
  conversions: number;
  /** Clicks per impression; null with no impressions, never a 0% that was never measured. */
  ctr: number | null;
  /** Null with no clicks, for the same reason. */
  cpcMicros: number | null;
}

export interface ReportDay {
  day: string;
  impressions: number;
  clicks: number;
  costMicros: number;
}

export interface ReportPlacement {
  key: string;
  label: string;
  platform: AdPlatform;
  impressions: number;
  clicks: number;
  costMicros: number;
}

/**
 * A place, per platform. Google places a viewer in a town and Meta only in a
 * region, so one list would rank "Riverton, Utah" against "Utah" as if they
 * were the same kind of place. Each platform gets its own list instead.
 */
export interface ReportLocation {
  label: string;
  platform: AdPlatform;
  impressions: number;
  clicks: number;
  costMicros: number;
}

export interface CampaignReport {
  totals: ReportTotals;
  daily: ReportDay[];
  placements: ReportPlacement[];
  locations: ReportLocation[];
  hasData: boolean;
}

/** How many places are listed before the rest become "Everywhere else". */
export const TOP_LOCATIONS = 8;

function nextDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

export function buildReport(
  rows: StoredStat[],
  window: {
    /** The first day the campaign could have run. */
    from: string | null;
    /**
     * The last day the platforms have reported on. Days up to here with no
     * row were days with nothing to report — both platforms leave a quiet day
     * out — and are drawn as zero; days after it are not drawn at all.
     */
    through: string | null;
  },
): CampaignReport {
  const totalsRows = rows.filter((r) => r.dimension === "total");

  const sum = (key: "impressions" | "clicks" | "costMicros" | "calls" | "leads" | "conversions") =>
    totalsRows.reduce((n, r) => n + r[key], 0);
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const costMicros = sum("costMicros");

  const totals: ReportTotals = {
    impressions,
    clicks,
    costMicros,
    calls: sum("calls"),
    leads: sum("leads"),
    conversions: Math.round(sum("conversions") * 10) / 10,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpcMicros: clicks > 0 ? Math.round(costMicros / clicks) : null,
  };

  const byDay = new Map<string, ReportDay>();
  for (const r of totalsRows) {
    const into = byDay.get(r.day) ?? { day: r.day, impressions: 0, clicks: 0, costMicros: 0 };
    byDay.set(r.day, {
      day: r.day,
      impressions: into.impressions + r.impressions,
      clicks: into.clicks + r.clicks,
      costMicros: into.costMicros + r.costMicros,
    });
  }

  const daily: ReportDay[] = [];
  const first = window.from ?? [...byDay.keys()].sort()[0] ?? null;
  const last = window.through ?? [...byDay.keys()].sort().at(-1) ?? null;
  if (first && last && first <= last) {
    let guard = 0;
    for (let day = first; day <= last && guard < 400; day = nextDay(day), guard += 1) {
      daily.push(byDay.get(day) ?? { day, impressions: 0, clicks: 0, costMicros: 0 });
    }
  }

  const placementMap = new Map<string, ReportPlacement>();
  for (const r of rows.filter((x) => x.dimension === "placement")) {
    const placement = placementFor(r.dimensionValue);
    const into = placementMap.get(placement.key) ?? { ...placement, impressions: 0, clicks: 0, costMicros: 0 };
    placementMap.set(placement.key, {
      ...into,
      impressions: into.impressions + r.impressions,
      clicks: into.clicks + r.clicks,
      costMicros: into.costMicros + r.costMicros,
    });
  }
  const placements = [...placementMap.values()]
    .filter((p) => p.impressions > 0 || p.clicks > 0)
    .sort((a, b) => b.impressions - a.impressions || a.label.localeCompare(b.label));

  const locationMap = new Map<string, ReportLocation>();
  for (const r of rows.filter((x) => x.dimension === "location")) {
    const platform: AdPlatform = r.platform === "meta" ? "meta" : "google_ads";
    const key = `${platform}|${r.dimensionValue}`;
    const into = locationMap.get(key) ?? { label: r.dimensionValue, platform, impressions: 0, clicks: 0, costMicros: 0 };
    locationMap.set(key, {
      ...into,
      impressions: into.impressions + r.impressions,
      clicks: into.clicks + r.clicks,
      costMicros: into.costMicros + r.costMicros,
    });
  }

  const locations: ReportLocation[] = [];
  for (const platform of ["google_ads", "meta"] as const) {
    const ranked = [...locationMap.values()]
      .filter((l) => l.platform === platform && (l.impressions > 0 || l.clicks > 0))
      .sort((a, b) => b.impressions - a.impressions || a.label.localeCompare(b.label));
    if (ranked.length <= TOP_LOCATIONS + 1) {
      locations.push(...ranked);
      continue;
    }
    locations.push(
      ...ranked.slice(0, TOP_LOCATIONS),
      ranked.slice(TOP_LOCATIONS).reduce<ReportLocation>(
        (other, l) => ({
          ...other,
          impressions: other.impressions + l.impressions,
          clicks: other.clicks + l.clicks,
          costMicros: other.costMicros + l.costMicros,
        }),
        { label: "Everywhere else", platform, impressions: 0, clicks: 0, costMicros: 0 },
      ),
    );
  }

  return { totals, daily, placements, locations, hasData: totalsRows.length > 0 };
}
