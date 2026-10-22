import type { DailyMetricsRow, DateRange, KeywordCount } from "./types";

/**
 * Performance figures over a window, and the dates the sync asks Google for.
 *
 * Google's Performance data runs a few days behind: yesterday is usually not
 * there yet. So a "last 30 days" window ends at the newest day Google has
 * actually reported, and the page names the dates — a window that silently
 * ended four days ago would make this week look like a slump.
 */

export const METRIC_WINDOWS = [30, 90] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

/** How far back the sync keeps figures: the longest window plus slack for Google's lag. */
export const METRICS_HISTORY_DAYS = 100;
/** Search terms are monthly; three full months covers the 90-day window. */
export const KEYWORD_MONTHS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isMetricWindow(value: unknown): value is MetricWindow {
  return typeof value === "number" && (METRIC_WINDOWS as readonly number[]).includes(value);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS));
}

/** What the sync requests: the last `METRICS_HISTORY_DAYS`, ending yesterday. */
export function syncRange(now: Date): DateRange {
  const end = addDays(isoDay(now), -1);
  return { start: addDays(end, -(METRICS_HISTORY_DAYS - 1)), end };
}

/** The first of each of the last `KEYWORD_MONTHS` complete months, oldest first. */
export function keywordMonths(now: Date): string[] {
  const months: string[] = [];
  for (let back = KEYWORD_MONTHS; back >= 1; back -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push(isoDay(d));
  }
  return months;
}

export interface MetricTotals {
  searchViews: number;
  mapsViews: number;
  views: number;
  calls: number;
  websiteClicks: number;
  directionRequests: number;
}

export type MetricsSummary =
  | { state: "none" }
  | {
      state: "ok";
      window: MetricWindow;
      range: DateRange;
      /** Days in the window Google reported on. Fewer than `window` early on. */
      daysReported: number;
      totals: MetricTotals;
    };

/**
 * Totals for the last `window` days Google has reported. "none" when there
 * are no rows at all — which the page shows as "no figures yet", never zeros.
 */
export function summarise(rows: DailyMetricsRow[], window: MetricWindow): MetricsSummary {
  if (rows.length === 0) return { state: "none" };
  const end = rows.reduce((latest, row) => (row.date > latest ? row.date : latest), rows[0]!.date);
  const start = addDays(end, -(window - 1));
  const inWindow = rows.filter((row) => row.date >= start && row.date <= end);

  const totals = inWindow.reduce<MetricTotals>(
    (sum, row) => ({
      searchViews: sum.searchViews + row.searchViews,
      mapsViews: sum.mapsViews + row.mapsViews,
      views: sum.views + row.searchViews + row.mapsViews,
      calls: sum.calls + row.calls,
      websiteClicks: sum.websiteClicks + row.websiteClicks,
      directionRequests: sum.directionRequests + row.directionRequests,
    }),
    { searchViews: 0, mapsViews: 0, views: 0, calls: 0, websiteClicks: 0, directionRequests: 0 },
  );

  return { state: "ok", window, range: { start, end }, daysReported: inWindow.length, totals };
}

export interface SearchSummary {
  months: string[];
  /** A floor: terms Google reports as "fewer than N" add nothing to it. */
  atLeast: number;
  /** Whether any term was below Google's threshold, so the total is a floor. */
  hasHidden: boolean;
  top: KeywordCount[];
}

/** Search terms over the given months, merged and ranked. Null when none are stored. */
export function summariseSearches(
  rows: Array<KeywordCount & { month: string }>,
  months: string[],
  limit = 5,
): SearchSummary | null {
  const inRange = rows.filter((row) => months.includes(row.month));
  if (inRange.length === 0) return null;

  const merged = new Map<string, KeywordCount>();
  for (const row of inRange) {
    const existing = merged.get(row.keyword);
    if (!existing) {
      merged.set(row.keyword, { keyword: row.keyword, impressions: row.impressions, belowThreshold: row.belowThreshold });
      continue;
    }
    const counted = (existing.impressions ?? 0) + (row.impressions ?? 0);
    merged.set(row.keyword, {
      keyword: row.keyword,
      impressions: counted > 0 ? counted : null,
      belowThreshold: counted > 0 ? null : (existing.belowThreshold ?? row.belowThreshold),
    });
  }

  const all = [...merged.values()];
  return {
    months: [...new Set(inRange.map((r) => r.month))].sort(),
    atLeast: all.reduce((sum, k) => sum + (k.impressions ?? 0), 0),
    hasHidden: inRange.some((r) => r.impressions === null),
    top: all
      .filter((k) => k.impressions !== null)
      .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0) || a.keyword.localeCompare(b.keyword))
      .slice(0, limit),
  };
}

/**
 * The months of search terms that stand in for a window: the latest complete
 * month for 30 days, the latest three for 90. Search terms only come by the
 * month, so the page names the months rather than pretending to the days.
 */
export function monthsForWindow(storedMonths: string[], window: MetricWindow): string[] {
  const latest = [...new Set(storedMonths)].sort().reverse();
  return latest.slice(0, window === 30 ? 1 : KEYWORD_MONTHS).sort();
}
