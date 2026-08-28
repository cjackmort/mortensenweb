import { describe, expect, it } from "vitest";
import { isValidRange, percentChange, statValue } from "@/lib/analytics/umami";
import { isValidUmamiWebsiteId, normaliseDomain } from "@/db/repositories/admin/sites";
import { demoAnalytics } from "@/lib/analytics/demo";

/**
 * Analytics plumbing.
 *
 * `statValue` has its own suite because of how its failure looked: Umami Cloud
 * returns `{"visitors": 12}` while older builds return `{"visitors": {"value":
 * 12}}`, and reading `.value` off a plain number yields `undefined`, which
 * becomes a clean, believable **zero**. Not an error — a zero. A client reading
 * that concludes nobody visited their site.
 *
 * §10 forbids exactly that ("never a silent zero"), so this is a regression
 * guard on the rule rather than on a line of code.
 */

describe("stat field parsing tolerates both API shapes", () => {
  it("reads Umami Cloud's flat numbers", () => {
    expect(statValue(12)).toBe(12);
    expect(statValue(0)).toBe(0);
  });

  it("reads the older wrapped shape", () => {
    expect(statValue({ value: 12 })).toBe(12);
    expect(statValue({ value: 0 })).toBe(0);
  });

  it("returns zero only when there is genuinely nothing to read", () => {
    expect(statValue(undefined)).toBe(0);
    expect(statValue({})).toBe(0);
  });

  it("never turns a real count into a zero", () => {
    // The actual regression: a truthy count must survive both shapes.
    for (const shape of [7, { value: 7 }] as const) {
      expect(statValue(shape)).toBe(7);
    }
  });
});

describe("range parsing", () => {
  it("accepts only the three supported windows", () => {
    expect(isValidRange(7)).toBe(true);
    expect(isValidRange(30)).toBe(true);
    expect(isValidRange(90)).toBe(true);
  });

  it("rejects anything else, including strings from a query param", () => {
    for (const bad of ["30", 0, -7, 365, null, undefined, {}]) {
      expect(isValidRange(bad)).toBe(false);
    }
  });
});

describe("umami website id validation", () => {
  it("accepts a UUID", () => {
    expect(isValidUmamiWebsiteId("4f5eaf4e-5e3e-4545-b742-d2fb05e1a911")).toBe(true);
    // Pasted with whitespace, as it arrives from a clipboard.
    expect(isValidUmamiWebsiteId("  4f5eaf4e-5e3e-4545-b742-d2fb05e1a911 ")).toBe(true);
  });

  it("rejects a partial paste or an API key pasted by mistake", () => {
    expect(isValidUmamiWebsiteId("not-a-uuid")).toBe(false);
    expect(isValidUmamiWebsiteId("4f5eaf4e-5e3e-4545-b742")).toBe(false);
    expect(isValidUmamiWebsiteId("")).toBe(false);
  });
});

describe("domain normalisation", () => {
  it("reduces a pasted URL to a bare hostname", () => {
    expect(normaliseDomain("https://scottmortensenfinearts.com/")).toBe(
      "scottmortensenfinearts.com",
    );
    expect(normaliseDomain("http://Example.COM/gallery.html")).toBe("example.com");
    expect(normaliseDomain("  example.com  ")).toBe("example.com");
  });

  it("returns null for nothing", () => {
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain("   ")).toBeNull();
  });
});

describe("demo analytics", () => {
  it("is deterministic, so the charts do not jitter on refresh", () => {
    const a = demoAnalytics("site-abc", 30);
    const b = demoAnalytics("site-abc", 30);
    expect(a.visitors).toBe(b.visitors);
    expect(a.series.map((p) => p.visitors)).toEqual(b.series.map((p) => p.visitors));
  });

  it("differs per site, so two clients do not see identical traffic", () => {
    expect(demoAnalytics("site-abc", 30).visitors).not.toBe(
      demoAnalytics("site-xyz", 30).visitors,
    );
  });

  it("produces one point per day in the range", () => {
    expect(demoAnalytics("site-abc", 7).series).toHaveLength(7);
    expect(demoAnalytics("site-abc", 90).series).toHaveLength(90);
  });
});

/**
 * Period-over-period change.
 *
 * The arrows on the dashboard are the one thing on it that is *derived* rather
 * than reported, so they are the one thing that can be wrong while every figure
 * around them is right. Two failure modes matter, and both produce something
 * that renders perfectly:
 *
 *   - a zero baseline divides to `Infinity`, which formats as a number;
 *   - a guarded zero baseline usually returns 100%, which tells a client their
 *     traffic doubled when it actually appeared out of nothing.
 *
 * Both must come back null so the component draws no arrow at all. "We cannot
 * say" and "no change" are different claims, and only one of them is true.
 */
describe("period-over-period change", () => {
  it("reports growth and decline as a signed fraction", () => {
    expect(percentChange(120, 100)).toBeCloseTo(0.2);
    expect(percentChange(80, 100)).toBeCloseTo(-0.2);
    expect(percentChange(100, 100)).toBe(0);
  });

  it("refuses to divide by a zero baseline", () => {
    // The regression: growth from nothing is not a percentage.
    expect(percentChange(50, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(-3, 0)).toBeNull();
  });

  it("refuses a negative baseline, which no count can have", () => {
    expect(percentChange(10, -5)).toBeNull();
  });

  it("never returns a non-finite number the UI would format", () => {
    for (const [now, before] of [
      [1, 0],
      [Number.POSITIVE_INFINITY, 10],
      [10, Number.NaN],
      [Number.NaN, 10],
    ] as const) {
      const result = percentChange(now, before);
      expect(result === null || Number.isFinite(result)).toBe(true);
    }
  });

  it("survives a drop to zero, which is real and must still be shown", () => {
    // Traffic falling to nothing is a fact worth an arrow, unlike growth from
    // nothing. -100% is the correct answer here, not null.
    expect(percentChange(0, 40)).toBe(-1);
  });
});

describe("demo analytics comparison window", () => {
  it("includes a previous period, so the arrows have something to point at", () => {
    const demo = demoAnalytics("site-abc", 30);
    expect(demo.previous).not.toBeNull();
    expect(demo.previous!.visitors).toBeGreaterThan(0);
  });

  it("keeps the comparison deterministic along with everything else", () => {
    expect(demoAnalytics("site-abc", 30).previous).toEqual(
      demoAnalytics("site-abc", 30).previous,
    );
  });

  it("still shows only the requested range, not the run-up used to compare", () => {
    // The generator produces twice the range and discards the first half. A
    // regression here would leak 60 days of history onto a 30-day chart.
    expect(demoAnalytics("site-abc", 30).series).toHaveLength(30);
    expect(demoAnalytics("site-abc", 7).series).toHaveLength(7);
  });
});
