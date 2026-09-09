import { describe, expect, it } from "vitest";
import {
  conversionRate,
  deriveMetrics,
  formatDuration,
  formatPercent,
  METRIC_LABELS,
  percentChange,
  shareOf,
} from "@/lib/analytics/metrics";

/**
 * Metric derivation.
 *
 * The case that matters most is the one that was wrong: Umami accumulates
 * `bounces` and `totaltime` per **visit**, and the old code divided both by
 * `visitors`. That is wrong by exactly the average visits-per-visitor, which is
 * small enough to look entirely plausible on a dashboard.
 */

describe("deriveMetrics", () => {
  it("divides bounce and duration by visits, not visitors", () => {
    // 100 people made 200 visits. 50 of those visits bounced.
    const derived = deriveMetrics({
      visitors: 100,
      visits: 200,
      pageviews: 500,
      bounces: 50,
      totaltime: 12_000,
    });

    // 50/200 = 25%. Dividing by visitors would give 50% — twice the truth.
    expect(derived.bounceRate).toBeCloseTo(0.25);
    // 12000/200 = 60s. Dividing by visitors would give 120s.
    expect(derived.avgVisitSeconds).toBe(60);
  });

  it("returns null rather than zero when there is nothing to divide by", () => {
    const derived = deriveMetrics({
      visitors: 0,
      visits: 0,
      pageviews: 0,
      bounces: 0,
      totaltime: 0,
    });

    // Zero is a real value for a bounce rate, so it cannot double as "unknown".
    expect(derived.bounceRate).toBeNull();
    expect(derived.avgVisitSeconds).toBeNull();
    expect(derived.pageviewsPerVisit).toBeNull();
  });

  it("reports an impossible ratio instead of clamping it", () => {
    // The old implementation wrapped this in Math.min(1, …), which turned an
    // obviously broken 340% into a plausible 100% and hid the bug that caused
    // it. A figure that cannot be right should look wrong.
    const derived = deriveMetrics({
      visitors: 10,
      visits: 10,
      pageviews: 10,
      bounces: 34,
      totaltime: 100,
    });

    expect(derived.anomaly).toMatch(/More bounces/);
    expect(derived.bounceRate).toBeGreaterThan(1);
  });

  it("notices more visitors than visits", () => {
    const derived = deriveMetrics({
      visitors: 50,
      visits: 20,
      pageviews: 60,
      bounces: 5,
      totaltime: 400,
    });
    expect(derived.anomaly).toMatch(/More visitors/);
  });

  it("notices bounce figures arriving with no visits", () => {
    const derived = deriveMetrics({
      visitors: 0,
      visits: 0,
      pageviews: 0,
      bounces: 7,
      totaltime: 0,
    });
    expect(derived.anomaly).toMatch(/no visits/);
  });

  it("is silent when the figures are coherent", () => {
    const derived = deriveMetrics({
      visitors: 10,
      visits: 14,
      pageviews: 40,
      bounces: 4,
      totaltime: 700,
    });
    expect(derived.anomaly).toBeNull();
  });
});

describe("percentChange", () => {
  it("computes an ordinary change", () => {
    expect(percentChange(120, 100)).toBeCloseTo(0.2);
    expect(percentChange(80, 100)).toBeCloseTo(-0.2);
  });

  it("refuses to divide by a zero baseline", () => {
    // The naive version yields Infinity; the usual guard returns 100%, which
    // claims traffic doubled when it appeared out of nothing. Both are worse
    // than drawing no arrow.
    expect(percentChange(50, 0)).toBeNull();
  });

  it("returns null when either side is unknown", () => {
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(100, null)).toBeNull();
  });
});

describe("shareOf", () => {
  it("carries the denominator it used", () => {
    // A percentage of the visible rows and a percentage of everything are
    // different claims, and a breakdown that truncates has to say which.
    const ofAll = shareOf(20, 200, "all_activity");
    const ofShown = shareOf(20, 50, "shown_rows");

    expect(ofAll.fraction).toBeCloseTo(0.1);
    expect(ofAll.basis).toBe("all_activity");
    expect(ofShown.fraction).toBeCloseTo(0.4);
    expect(ofShown.basis).toBe("shown_rows");
  });

  it("returns null rather than dividing by zero", () => {
    expect(shareOf(0, 0, "all_activity").fraction).toBeNull();
  });
});

describe("conversionRate", () => {
  it("refuses a rate when only occurrences are known", () => {
    // The trap: 40 taps from 100 visitors is not "40% of visitors", because one
    // person tapping four times makes four occurrences.
    const result = conversionRate({
      uniqueConverters: null,
      denominator: 100,
      denominatorLabel: "visits",
      occurrences: 40,
    });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.occurrences).toBe(40);
    expect(result.reason).toMatch(/how many times/);
  });

  it("computes a rate when unique converters are known", () => {
    const result = conversionRate({
      uniqueConverters: 25,
      denominator: 100,
      denominatorLabel: "visits",
      occurrences: 40,
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.rate).toBeCloseTo(0.25);
    expect(result.basis).toBe("visits");
  });

  it("refuses when the denominator is empty", () => {
    const result = conversionRate({
      uniqueConverters: 3,
      denominator: 0,
      denominatorLabel: "visits",
      occurrences: 3,
    });
    expect(result.available).toBe(false);
  });
});

describe("labels", () => {
  it("does not claim to know why someone left", () => {
    // "Left straight away" asserted intent. Someone who found the phone number
    // on the first page and rang it "left straight away" and had a perfect
    // visit.
    expect(METRIC_LABELS.bounceRate).toBe("Single-page visits");
    expect(METRIC_LABELS.bounceRate.toLowerCase()).not.toContain("left");
    expect(METRIC_LABELS.bounceRate.toLowerCase()).not.toContain("bounce");
  });

  it("says average where it means average", () => {
    expect(METRIC_LABELS.avgVisitSeconds).toBe("Average visit duration");
  });

  it("distinguishes visitors from visits", () => {
    expect(METRIC_LABELS.visitors).toBe("Visitors");
    expect(METRIC_LABELS.visits).toBe("Visits");
  });
});

describe("formatting", () => {
  it("renders an unknown value as a dash, never as zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats durations readably", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(95)).toBe("1m 35s");
  });
});
