/**
 * What each figure means, and how it is derived.
 *
 * Written down because the previous implementation divided by the wrong thing
 * and nothing caught it. Umami returns five raw counters, and two of them —
 * `bounces` and `totaltime` — are accumulated **per visit**. The dashboard
 * divided both by `visitors`, which produces a number that is wrong by exactly
 * the average number of visits per visitor, and looks entirely plausible.
 *
 * Umami's own definitions, from their documentation:
 *
 *   visitors    unique visitors                          count(distinct session_id)
 *   visits      sessions                                 count(distinct visit_id)
 *   pageviews   page views                               count(*)
 *   bounces     visits with a single pageview and no
 *               custom event
 *   totaltime   summed time between first and last
 *               event, per visit
 *
 *   bounce rate          = bounces / visits
 *   average visit time   = totaltime / visits
 *
 * The endpoint has always returned `visits`. The old code simply never read it.
 *
 * ## Why there is no clamp here
 *
 * The previous version wrapped the bounce rate in `Math.min(1, …)`. That looks
 * like defensive programming and is the opposite: with the wrong denominator
 * the ratio regularly exceeded 1, and the clamp turned an obviously broken
 * 340% into a plausible 100%. It hid the very bug it was working around. A
 * ratio above 1 now surfaces as an anomaly the caller can report, because a
 * figure that cannot be right should look wrong.
 */

export interface RawCounters {
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  totaltime: number;
}

export interface DerivedMetrics {
  visitors: number;
  visits: number;
  pageviews: number;
  /** 0–1, or null when there were no visits to divide by. */
  bounceRate: number | null;
  /** Seconds, or null when there were no visits to divide by. */
  avgVisitSeconds: number | null;
  /** Pageviews per visit. Descriptive only — not a quality score. */
  pageviewsPerVisit: number | null;
  /**
   * Set when a derived ratio came out impossible — a bounce rate above 100%,
   * or more bounces than visits. Means the provider's figures disagree with
   * each other, and is surfaced rather than clamped away.
   */
  anomaly: string | null;
}

/**
 * Derive the presentable figures from the raw counters.
 *
 * Every division guards its denominator and returns **null**, not zero, when
 * there is nothing to divide by. Zero is a real value for these metrics — a
 * 0% bounce rate is meaningful — so using it for "unknown" would be another
 * silent zero of exactly the kind this codebase keeps having to remove.
 */
export function deriveMetrics(raw: RawCounters): DerivedMetrics {
  const { visitors, visits, pageviews, bounces, totaltime } = raw;

  let anomaly: string | null = null;

  if (visits > 0 && bounces > visits) {
    anomaly = `More bounces (${bounces}) than visits (${visits}).`;
  } else if (visits === 0 && (bounces > 0 || totaltime > 0)) {
    anomaly = "Bounce and duration figures arrived with no visits to divide by.";
  } else if (visitors > visits && visits > 0) {
    // A visitor cannot have fewer visits than themselves.
    anomaly = `More visitors (${visitors}) than visits (${visits}).`;
  }

  return {
    visitors,
    visits,
    pageviews,
    bounceRate: visits > 0 ? bounces / visits : null,
    avgVisitSeconds: visits > 0 ? Math.round(totaltime / visits) : null,
    pageviewsPerVisit: visits > 0 ? pageviews / visits : null,
    anomaly,
  };
}

/**
 * Change from `previous` to `current`, as a signed fraction.
 *
 * Null when there is no honest answer. Growth from zero is the case that
 * matters: the naive version divides by it and renders `Infinity`, and the
 * usual guard returns 100%, which claims the traffic doubled when it actually
 * appeared out of nothing. Both are worse than drawing no arrow at all.
 */
export function percentChange(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/**
 * The share one row represents, and what it is a share *of*.
 *
 * Breakdown lists are truncated for display, so a percentage computed against
 * the visible rows says something different from one computed against
 * everything — and the difference is large when a long tail is cut off. The
 * denominator travels with the number so the UI can state which it used, which
 * the brief requires and the old implementation did not do at all.
 */
export interface Share {
  value: number;
  fraction: number | null;
  denominator: number;
  basis: "all_activity" | "shown_rows";
}

export function shareOf(
  value: number,
  denominator: number,
  basis: Share["basis"],
): Share {
  return {
    value,
    denominator,
    basis,
    fraction: denominator > 0 ? value / denominator : null,
  };
}

/**
 * A conversion rate, only when both halves are honestly countable.
 *
 * The trap this exists to refuse: dividing a count of *event occurrences* by a
 * count of *visitors*. One person tapping a phone number three times makes
 * three occurrences, so that ratio can exceed 100% and does not describe any
 * proportion of people. Umami's metrics endpoint returns occurrences, not
 * unique converters, so unless a unique count is supplied there is no rate to
 * show — and the brief is explicit that a count alone is better than an
 * invented rate.
 */
export type ConversionRate =
  | { available: true; rate: number; numerator: number; denominator: number; basis: string }
  | { available: false; reason: string; occurrences: number };

export function conversionRate(input: {
  /** People who completed the action. Not occurrences. */
  uniqueConverters: number | null;
  /** The population they came from. */
  denominator: number;
  denominatorLabel: string;
  /** Raw occurrences, always shown even when no rate is possible. */
  occurrences: number;
}): ConversionRate {
  if (input.uniqueConverters === null) {
    return {
      available: false,
      occurrences: input.occurrences,
      reason:
        "Umami reports how many times this happened, not how many different " +
        "people did it, so a percentage would not describe a share of anyone.",
    };
  }
  if (input.denominator <= 0) {
    return {
      available: false,
      occurrences: input.occurrences,
      reason: "There were no visits in this period to compare against.",
    };
  }
  return {
    available: true,
    rate: input.uniqueConverters / input.denominator,
    numerator: input.uniqueConverters,
    denominator: input.denominator,
    basis: input.denominatorLabel,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Metric labels, in one place so the dashboard and any future export agree.
 *
 * Two of these are corrections the brief asked for by name. "Left straight
 * away" claimed to know intent — someone who found a phone number on the first
 * page and rang it "left straight away" and had a perfect visit. "Single-page
 * visits" describes what was measured and nothing more.
 */
export const METRIC_LABELS = {
  visitors: "Visitors",
  visits: "Visits",
  pageviews: "Page views",
  avgVisitSeconds: "Average visit duration",
  bounceRate: "Single-page visits",
  pageviewsPerVisit: "Pages per visit",
} as const;

export const METRIC_DESCRIPTIONS = {
  visitors: "Different people, counted once each however often they came back.",
  visits: "Separate sessions. One person visiting twice counts as two.",
  pageviews: "Pages opened in total.",
  avgVisitSeconds: "Total time on the site divided by the number of visits.",
  // Explicitly not framed as good or bad. A single-page visit can be a complete
  // success — the visitor found the phone number and rang it.
  bounceRate:
    "Visits where someone saw one page and did nothing else we track. " +
    "Not necessarily a bad thing: finding a phone number on the first page and " +
    "ringing it looks exactly like this.",
  pageviewsPerVisit: "Pages opened per visit, on average.",
} as const;

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null) return "—";
  return `${Math.round(fraction * 100)}%`;
}
