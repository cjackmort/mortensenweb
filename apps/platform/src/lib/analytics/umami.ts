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
  pageviews: number;
  bounceRate: number;
  avgSecondsOnSite: number;
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
 * Change from `previous` to `current`, as a signed fraction.
 *
 * Null when there is no honest answer. Growth from zero is the case that
 * matters: every naive implementation divides by it and renders `Infinity`,
 * and the ones that guard usually return 100%, which claims the traffic
 * doubled when it actually appeared out of nothing. Both are worse than
 * showing no arrow, so a zero baseline yields null and the caller draws
 * nothing.
 */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return (current - previous) / previous;
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
  days: RangeDays,
): Promise<AnalyticsState> {
  if (!isUmamiConfigured()) return { kind: "not_configured" };
  if (!websiteId) return { kind: "not_connected" };

  const endAt = Date.now();
  const span = days * 24 * 60 * 60 * 1000;
  const startAt = endAt - span;
  const window = { startAt, endAt };
  // The window immediately before this one, same length, no overlap: the last
  // 30 days against the 30 before them. Comparing against a *calendar* month
  // would be a different question, and a misleading one on the 3rd.
  const priorWindow = { startAt: startAt - span, endAt: startAt };

  try {
    const [stats, prior, pageviewSeries, pages, referrers, devices, countries, events] =
      await Promise.all([
        umamiFetch<UmamiStatsResponse>(`/websites/${websiteId}/stats`, window),
        // The comparison is the one call allowed to fail on its own. Everything
        // else here is the page; this is an annotation on it, and losing the
        // arrows is much better than losing the figures they annotate.
        umamiFetch<UmamiStatsResponse>(
          `/websites/${websiteId}/stats`,
          priorWindow,
        ).catch(() => null),
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
        // Custom events. Umami exposes them through the same metrics endpoint,
        // so this costs one more call rather than a second integration. A site
        // that emits none returns an empty list, which the panel renders as a
        // setup prompt rather than a zero.
        umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
          ...window,
          type: "event",
          limit: 12,
        }),
      ]);

    const visitors = statValue(stats.visitors);
    const pageviews = statValue(stats.pageviews);
    const bounces = statValue(stats.bounces);
    const totalTime = statValue(stats.totaltime);

    const priorVisitors = prior ? statValue(prior.visitors) : 0;
    const previous: PriorPeriod | null = prior
      ? {
          visitors: priorVisitors,
          pageviews: statValue(prior.pageviews),
          bounceRate:
            priorVisitors > 0
              ? Math.min(1, statValue(prior.bounces) / priorVisitors)
              : 0,
          avgSecondsOnSite:
            priorVisitors > 0
              ? Math.round(statValue(prior.totaltime) / priorVisitors)
              : 0,
        }
      : null;

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
        events: toBreakdown(events, 12),
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
