import type { AdPlatform } from "@mortensenweb/plans";

/**
 * One day of results for one channel, in the shape both platform clients
 * return and `ad_stats_daily` stores.
 */

export type StatDimension = "total" | "placement" | "location";

export interface AdStatRow {
  day: string;
  dimension: StatDimension;
  /** Empty for a total; a placement key; a place name. */
  value: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  calls: number;
  leads: number;
  conversions: number;
}

/** Environment variables, as a plain record so tests can pass their own. */
export type Env = Record<string, string | undefined>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A platform said no, sorted by what the operator has to do about it. The
 * message is the platform's own, kept for the operator's screen; clients see
 * only that results are delayed.
 */
export class AdsApiError extends Error {
  constructor(
    readonly platform: AdPlatform,
    readonly kind: "auth" | "permission" | "not_found" | "quota" | "invalid" | "unavailable",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AdsApiError";
  }
}

export function kindForStatus(status: number): AdsApiError["kind"] {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "quota";
  if (status >= 500) return "unavailable";
  return "invalid";
}

/** Platforms send counts as strings (int64 in JSON). Anything unreadable is 0. */
export function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Adds rows that share a day, dimension and value — several pages, or two raw values that map to one key. */
export function mergeRows(rows: AdStatRow[]): AdStatRow[] {
  const merged = new Map<string, AdStatRow>();
  for (const row of rows) {
    const key = `${row.day}|${row.dimension}|${row.value}`;
    const into = merged.get(key);
    if (!into) {
      merged.set(key, { ...row });
      continue;
    }
    merged.set(key, {
      ...into,
      impressions: into.impressions + row.impressions,
      clicks: into.clicks + row.clicks,
      costMicros: into.costMicros + row.costMicros,
      calls: into.calls + row.calls,
      leads: into.leads + row.leads,
      conversions: into.conversions + row.conversions,
    });
  }
  return [...merged.values()];
}
