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

import {
  deriveMetrics,
  percentChange as percentChangeImpl,
} from "./metrics";
import {
  previousWindow,
  providerParams,
  resolveWindow,
  type AnalyticsFilters,
  type DateWindow,
} from "./filters";

export interface SeriesPoint {
  date: string;
  /**
   * Sessions on this day, or null when the provider sent no series for them.
   *
   * Nullable on purpose: zero is a real value, so it cannot also mean "we were
   * not told". Conflating the two is how a chart shows a dead site that is in
   * fact perfectly healthy.
   */
  visits: number | null;
  pageviews: number;
}

export interface Breakdown {
  label: string;
  value: number;
}

/**
 * The same four headline figures for the window immediately before this one,
 * of the same length. Present only so the dashboard can say "up 12% on the
 * previous 30 days" — which is a different and usually more useful fact than
 * the count itself, because a client already knows roughly what normal is.
 *
 * Null rather than zeroed when the comparison call fails. A missing comparison
 * must render as no arrow at all: a 0% change and an unavailable change look
 * identical once they are drawn, and mean opposite things.
 */
export interface PriorPeriod {
  visitors: number;
  /** Sessions. The denominator for bounce rate and visit duration. */
  visits: number;
  pageviews: number;
  /** 0–1, or null when there were no visits to divide by. */
  bounceRate: number | null;
  /** Seconds, or null when there were no visits to divide by. */
  avgVisitSeconds: number | null;
}

export interface AnalyticsSummary {
  visitors: number;
  /**
   * Sessions, and the denominator Umami defines for both derived metrics.
   *
   * The endpoint has always returned this. The previous implementation never
   * read it and divided by `visitors` instead, which is wrong by exactly the
   * average visits-per-visitor — small enough to look plausible.
   */
  visits: number;
  pageviews: number;
  /** 0–1, or null when there were no visits. Never a "score". */
  bounceRate: number | null;
  avgVisitSeconds: number | null;
  /** Set when the provider's own figures contradict each other. */
  anomaly: string | null;
  series: SeriesPoint[];
  /**
   * False when the provider returned no per-day visit series.
   *
   * The old code read `sessions` off the pageviews response and defaulted a
   * missing value to zero, so a change in the provider's response shape would
   * have drawn a flat line along the bottom of the chart and called it
   * "visitors". The chart refuses to plot the series at all rather than
   * inventing one.
   */
  hasVisitSeries: boolean;
  topPages: Breakdown[];
  referrers: Breakdown[];
  devices: Breakdown[];
  countries: Breakdown[];
  /**
   * What visitors actually did, rather than merely looked at.
   *
   * Empty until a site emits `data-umami-event` attributes — see the
   * `site-build` skill. A client with 200 visitors and no idea whether any of
   * them tried to call is being shown traffic, not business.
   */
  events: Breakdown[];
  /** The equivalent window before this one, or null when it is unavailable. */
  previous: PriorPeriod | null;
  /** When these figures were produced. Always shown. */
  generatedAt: Date;
}

/**
 * Re-exported from `./metrics`, where the arithmetic now lives.
 *
 * Kept on this module because several admin pages already import it from here,
 * and moving the import site is churn with no benefit.
 */
export const percentChange = percentChangeImpl;

/**
 * Every state the dashboard can be in. Distinguishing them is the point:
 * "not connected yet" is a setup task, "the API is down" is our problem, and
 * "genuinely no visitors" is information about the site.
 */
export type AnalyticsState =
  | {
      kind: "ok";
      data: AnalyticsSummary;
      isDemo: boolean;
      /**
       * True when every counter is zero for the window.
       *
       * Distinguished from `not_connected` because they call for opposite
       * responses: one is a quiet month, the other is a setup task nobody did.
       */
      isEmpty: boolean;
      /**
       * True when filters are active and excluded everything.
       *
       * A third distinct state, because "no results for this filter" invites
       * clearing the filter, while "no activity" does not.
       */
      filteredToNothing: boolean;
    }
  /** No Umami credentials on this server at all. */
  | { kind: "not_configured" }
  /** Credentials exist; this particular site has no Umami website id. */
  | { kind: "not_connected" }
  /** The provider failed. Never rendered as zeroes. */
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
  /**
   * Sessions. Returned by the endpoint all along, and the denominator Umami
   * documents for both bounce rate and average visit time.
   */
  visits?: UmamiStatField;
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

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type ProvisionResult =
  | { ok: true; websiteId: string; created: boolean }
  | { ok: false; reason: "not_configured" | "failed"; message: string };

/**
 * Create a website in Umami and return its id.
 *
 * Called at launch, so the client's dashboard has figures from the first
 * visitor rather than from whenever somebody remembered to set it up.
 *
 * The existing-website check comes first and matters more than it looks:
 * re-running a launch is a normal thing to do — a DNS change that did not take,
 * a domain corrected after a typo — and creating a second Umami website for the
 * same domain splits that site's history across two ids, with no way to merge
 * them afterwards.
 */
export async function provisionWebsite(input: {
  name: string;
  domain: string;
}): Promise<ProvisionResult> {
  if (!isUmamiConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Umami credentials are not set in this environment.",
    };
  }

  const base = process.env.UMAMI_API_BASE_URL!.replace(/\/$/, "");
  const key = process.env.UMAMI_API_KEY!;
  const domain = input.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  const headers = {
    Authorization: `Bearer ${key}`,
    "x-umami-api-key": key,
    "Content-Type": "application/json",
  };

  try {
    const existing = await fetch(`${base}/websites`, {
      headers,
      cache: "no-store",
    });

    if (existing.ok) {
      // Both shapes seen in the wild: a bare array, and `{ data: [...] }`.
      const body = (await existing.json()) as
        | { data?: { id: string; domain: string }[] }
        | { id: string; domain: string }[];
      const list = Array.isArray(body) ? body : (body.data ?? []);
      const match = list.find((site) => site.domain === domain);
      if (match) return { ok: true, websiteId: match.id, created: false };
    }

    const response = await fetch(`${base}/websites`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: input.name, domain }),
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: "failed",
        message: `Umami responded ${response.status} when creating the website.`,
      };
    }

    const created = (await response.json()) as { id?: string };
    if (!created.id) {
      return {
        ok: false,
        reason: "failed",
        message: "Umami created the website but returned no id.",
      };
    }

    return { ok: true, websiteId: created.id, created: true };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * The tracking snippet for a site.
 *
 * Returned as a string for the *agent* to place in the client repository, which
 * is why the script URL is derived from the configured API base rather than
 * hardcoded: self-hosted and Cloud serve the script from different origins, and
 * a snippet pointing at the wrong one fails silently — the page loads, nothing
 * is recorded, and the dashboard shows a zero that looks like "no visitors".
 */
export function trackingSnippet(websiteId: string): string {
  const base = process.env.UMAMI_API_BASE_URL ?? "";
  const scriptOrigin = base
    .replace(/\/api\/?$/, "")
    .replace(/^https:\/\/api\.umami\.is\/v1$/, "https://cloud.umami.is")
    .replace(/\/$/, "");

  return `<script defer src="${scriptOrigin}/script.js" data-website-id="${websiteId}"></script>`;
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
  rangeOrFilters: RangeDays | AnalyticsFilters,
  options: { timeZone?: string; now?: Date } = {},
): Promise<AnalyticsState> {
  if (!isUmamiConfigured()) return { kind: "not_configured" };
  if (!websiteId) return { kind: "not_connected" };

  // Callers that predate filtering still pass a plain day count. Accepting both
  // keeps the admin pages working without a mechanical edit across four files.
  const filters: AnalyticsFilters =
    typeof rangeOrFilters === "number"
      ? { range: rangeOrFilters, compare: true }
      : rangeOrFilters;

  const timeZone =
    options.timeZone ?? process.env.BUSINESS_TIMEZONE ?? "America/Denver";

  const window = resolveWindow(filters, timeZone, options.now);
  const prior = previousWindow(window);
  const dimensions = providerParams(filters);

  const windowParams = { startAt: window.startAt, endAt: window.endAt, ...dimensions };
  const priorParams = { startAt: prior.startAt, endAt: prior.endAt, ...dimensions };

  try {
    const [stats, priorStats, pageviewSeries, pages, referrers, devices, countries, events] =
      await Promise.all([
        umamiFetch<UmamiStatsResponse>(`/websites/${websiteId}/stats`, windowParams),
        // The one call allowed to fail alone. Everything else here is the page;
        // this is an annotation on it, and losing the arrows is much better
        // than losing the figures they annotate.
        filters.compare
          ? umamiFetch<UmamiStatsResponse>(
              `/websites/${websiteId}/stats`,
              priorParams,
            ).catch(() => null)
          : Promise.resolve(null),
        umamiFetch<{ pageviews?: UmamiMetric[]; sessions?: UmamiMetric[] }>(
          `/websites/${websiteId}/pageviews`,
          { ...windowParams, unit: "day", timezone: timeZone },
        ),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...windowParams,
          type: "url",
        }),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...windowParams,
          type: "referrer",
        }),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...windowParams,
          type: "device",
        }),
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...windowParams,
          type: "country",
        }),
        /*
         * Custom events, requested well past what is displayed.
         *
         * The brief is explicit that a filter must query the full dataset
         * rather than narrow an already-truncated top ten — with a limit of 12,
         * filtering to "contact intent" could return nothing simply because the
         * calls sat at position 13 behind a wall of photographs.
         */
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...windowParams,
          type: "event",
          limit: 500,
        }),
      ]);

    const derived = deriveMetrics({
      visitors: statValue(stats.visitors),
      visits: statValue(stats.visits),
      pageviews: statValue(stats.pageviews),
      bounces: statValue(stats.bounces),
      totaltime: statValue(stats.totaltime),
    });

    const previous: PriorPeriod | null = priorStats
      ? (() => {
          const p = deriveMetrics({
            visitors: statValue(priorStats.visitors),
            visits: statValue(priorStats.visits),
            pageviews: statValue(priorStats.pageviews),
            bounces: statValue(priorStats.bounces),
            totaltime: statValue(priorStats.totaltime),
          });
          return {
            visitors: p.visitors,
            visits: p.visits,
            pageviews: p.pageviews,
            bounceRate: p.bounceRate,
            avgVisitSeconds: p.avgVisitSeconds,
          };
        })()
      : null;

    /*
     * The per-day visit series, if the provider sent one.
     *
     * `sessions` is absent from some builds of the pageviews endpoint. The old
     * code defaulted a missing value to zero per day, which would have drawn a
     * flat line along the bottom of the chart labelled "visitors" — a silent
     * zero of exactly the kind this module's header forbids. Absence is now
     * carried through as null and the chart declines to plot it.
     */
    const sessionRows = pageviewSeries.sessions;
    const hasVisitSeries = Array.isArray(sessionRows) && sessionRows.length > 0;
    const visitsByDate = new Map(
      (sessionRows ?? []).map((row) => [row.x ?? "", row.y]),
    );

    const series: SeriesPoint[] = (pageviewSeries.pageviews ?? []).map((point) => ({
      date: point.x ?? "",
      pageviews: point.y,
      visits: hasVisitSeries ? (visitsByDate.get(point.x ?? "") ?? 0) : null,
    }));

    const isEmpty =
      derived.visitors === 0 && derived.pageviews === 0 && events.length === 0;
    const filtering = Object.keys(dimensions).length > 0;

    return {
      kind: "ok",
      isDemo: false,
      isEmpty: isEmpty && !filtering,
      // Same emptiness, different cause and different advice: clear the filter.
      filteredToNothing: isEmpty && filtering,
      data: {
        visitors: derived.visitors,
        visits: derived.visits,
        pageviews: derived.pageviews,
        bounceRate: derived.bounceRate,
        avgVisitSeconds: derived.avgVisitSeconds,
        anomaly: derived.anomaly,
        series,
        hasVisitSeries,
        topPages: toBreakdown(pages),
        referrers: toBreakdown(referrers),
        devices: toBreakdown(devices, 4),
        countries: toBreakdown(countries),
        // Kept whole. The event panels classify and group these themselves, and
        // truncating here would decide the answer before the question was
        // asked.
        events: toBreakdown(events, 500),
        previous,
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

/** The window a set of filters resolves to. Exported so the UI can label it. */
export function describeWindow(
  filters: AnalyticsFilters,
  timeZone: string,
  now?: Date,
): DateWindow {
  return resolveWindow(filters, timeZone, now);
}
