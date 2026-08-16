import { describe, expect, it } from "vitest";
import { isValidRange, statValue } from "@/lib/analytics/umami";
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
