/**
 * Umami analytics — server side only.
 *
 * THE RULE THAT MATTERS: `UMAMI_API_KEY` is a server secret. Nothing in this
 * module may be imported from a client component, and no value here may be
 * given a `NEXT_PUBLIC_` name. The portal proxies every Umami call so the key
 * never reaches a browser, which is also why the client dashboard renders
 * charts from data passed down as props rather than fetching anything itself.
 *
 * The second rule, from §10: **never a silent zero.** A zero that means "no
 * visitors" and a zero that means "the API is down" look identical on a chart
 * and mean opposite things to a client deciding whether their site is working.
 * Every failure path here returns a distinct state the UI renders explicitly.
 */

export interface SeriesPoint {
  date: string;
  visitors: number;
  pageviews: number;
}

export interface Breakdown {
  label: string;
  value: number;
}

export interface AnalyticsSummary {
  visitors: number;
  pageviews: number;
  /** 0–1. Rendered as a percentage; never as a "score". */
  bounceRate: number;
  avgSecondsOnSite: number;
  series: SeriesPoint[];
  topPages: Breakdown[];
  referrers: Breakdown[];
  devices: Breakdown[];
  countries: Breakdown[];
  /** When these figures were produced. Always shown. */
  generatedAt: Date;
}

/**
 * Every state the dashboard can be in. Distinguishing them is the point:
 * "not connected yet" is a setup task, "the API is down" is our problem, and
 * "genuinely no visitors" is information about the site.
 */
export type AnalyticsState =
  | { kind: "ok"; data: AnalyticsSummary; isDemo: boolean }
  | { kind: "not_configured" }
  | { kind: "not_connected" }
  | { kind: "error"; message: string };

export const RANGES = {
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
} as const;

export type RangeDays = keyof typeof RANGES;

export function isValidRange(value: unknown): value is RangeDays {
  return value === 7 || value === 30 || value === 90;
}

/** True when the server has what it needs to talk to Umami at all. */
export function isUmamiConfigured(): boolean {
  return Boolean(process.env.UMAMI_API_BASE_URL && process.env.UMAMI_API_KEY);
}

/**
 * `/stats` has shipped in two shapes, and the difference is dangerous rather
 * than merely annoying:
 *
 *   Umami Cloud v1   {"visitors": 12, ...}
 *   older builds     {"visitors": {"value": 12, "change": 3}, ...}
 *
 * Reading `.value` off a plain number yields `undefined`, which coerces to a
 * perfectly innocent-looking zero. That is a *silent* zero — indistinguishable
 * on screen from "nobody visited" — which §10 forbids precisely because a
 * client would read it as their site being dead. `statValue` accepts both.
 */
type UmamiStatField = number | { value?: number } | undefined;

interface UmamiStatsResponse {
  pageviews?: UmamiStatField;
  visitors?: UmamiStatField;
  bounces?: UmamiStatField;
  totaltime?: UmamiStatField;
}

export function statValue(field: UmamiStatField): number {
  if (typeof field === "number") return field;
  if (field && typeof field === "object" && typeof field.value === "number") {
    return field.value;
  }
  return 0;
}

type UmamiMetric = { x: string | null; y: number };

/**
 * The base URL must include whatever path prefix the deployment uses, because
 * Cloud and self-hosted differ:
 *
 *   Umami Cloud    https://api.umami.is/v1
 *   self-hosted    https://umami.example.com/api
 *
 * Hardcoding `/api` here worked only for self-hosted and silently 404s against
 * Cloud, so the prefix belongs in configuration rather than in this file.
 */
async function umamiFetch<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<T> {
  const base = process.env.UMAMI_API_BASE_URL!.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const key = process.env.UMAMI_API_KEY!;

  const response = await fetch(url, {
    // Both schemes, because the two deployments differ and sending the key
    // twice to the same host over TLS costs nothing:
    //   Umami Cloud   Authorization: Bearer <key>
    //   self-hosted   x-umami-api-key: <key>
    // Getting this wrong produces a 401, which the caller surfaces as an
    // explicit error rather than an empty chart.
    headers: {
      Authorization: `Bearer ${key}`,
      "x-umami-api-key": key,
    },
    // Aggregates are cached for five minutes. This is not only politeness:
    // Umami Cloud allows 50 calls per 15 seconds, and one uncached dashboard
    // load costs six. Without this, a handful of clients refreshing at once
    // would rate-limit each other.
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    // The status is safe to surface; the body may echo the query. Never the key.
    throw new Error(`Umami responded ${response.status}`);
  }
  return (await response.json()) as T;
}

function toBreakdown(rows: UmamiMetric[], limit = 6): Breakdown[] {
  return rows
    .filter((r) => typeof r.y === "number")
    .slice(0, limit)
    .map((r) => ({ label: r.x?.trim() || "(direct)", value: r.y }));
}

/**
 * Fetch one site's figures.
 *
 * `websiteId` comes from `analytics_connections`, which is per site. A caller
 * must have already established that the requesting session owns that site —
 * this function does no authorization of its own and must never be called with
 * an id taken straight from a request.
 */
export async function fetchAnalytics(
  websiteId: string,
  days: RangeDays,
): Promise<AnalyticsState> {
  if (!isUmamiConfigured()) return { kind: "not_configured" };
  if (!websiteId) return { kind: "not_connected" };

  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;
  const window = { startAt, endAt };

  try {
    const [stats, pageviewSeries, pages, referrers, devices, countries] =
      await Promise.all([
        umamiFetch<UmamiStatsResponse>(`/websites/${websiteId}/stats`, window),
        umamiFetch<{ pageviews: UmamiMetric[]; sessions: UmamiMetric[] }>(
          `/websites/${websiteId}/pageviews`,
          { ...window, unit: "day", timezone: process.env.BUSINESS_TIMEZONE ?? "America/Denver" },
        ),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...window,
          type: "url",
        }),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...window,
          type: "referrer",
        }),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...window,
          type: "device",
        }),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...window,
          type: "country",
        }),
      ]);

    const visitors = statValue(stats.visitors);
    const pageviews = statValue(stats.pageviews);
    const bounces = statValue(stats.bounces);
    const totalTime = statValue(stats.totaltime);

    const sessionsByDate = new Map(
      (pageviewSeries.sessions ?? []).map((s) => [s.x ?? "", s.y]),
    );

    const series: SeriesPoint[] = (pageviewSeries.pageviews ?? []).map((p) => ({
      date: p.x ?? "",
      pageviews: p.y,
      visitors: sessionsByDate.get(p.x ?? "") ?? 0,
    }));

    return {
      kind: "ok",
      isDemo: false,
      data: {
        visitors,
        pageviews,
        bounceRate: visitors > 0 ? Math.min(1, bounces / visitors) : 0,
        avgSecondsOnSite: visitors > 0 ? Math.round(totalTime / visitors) : 0,
        series,
        topPages: toBreakdown(pages),
        referrers: toBreakdown(referrers),
        devices: toBreakdown(devices, 4),
        countries: toBreakdown(countries),
        generatedAt: new Date(),
      },
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
