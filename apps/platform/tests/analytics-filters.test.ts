import { describe, expect, it } from "vitest";
import {
  cacheKey,
  hasActiveFilters,
  parseFilters,
  previousWindow,
  providerParams,
  resolveWindow,
  serialiseFilters,
  zonedDayStart,
} from "@/lib/analytics/filters";

/**
 * Filters, windows and cache keys.
 *
 * Two things here are security rather than correctness: no filter may name a
 * site, and no cache key may collide across tenants. Both are tested as
 * properties rather than as examples.
 */

const TZ = "America/Denver";

describe("parseFilters", () => {
  it("defaults to 30 days with comparison on", () => {
    const filters = parseFilters({});
    expect(filters.range).toBe(30);
    expect(filters.compare).toBe(true);
  });

  it("accepts the supported presets and rejects anything else", () => {
    expect(parseFilters({ range: "7" }).range).toBe(7);
    expect(parseFilters({ range: "90" }).range).toBe(90);
    // Not a preset: falls back rather than passing an arbitrary number through
    // to the provider.
    expect(parseFilters({ range: "365" }).range).toBe(30);
    expect(parseFilters({ range: "banana" }).range).toBe(30);
  });

  it("accepts a well-formed custom range", () => {
    const filters = parseFilters({ range: "custom", from: "2026-05-01", to: "2026-05-07" });
    expect(filters.range).toBe("custom");
    expect(filters.customStart).toBe("2026-05-01");
  });

  it("falls back when a custom range is half-valid or reversed", () => {
    expect(parseFilters({ range: "custom", from: "2026-05-01" }).range).toBe(30);
    expect(parseFilters({ range: "custom", from: "nope", to: "2026-05-07" }).range).toBe(30);
    // End before start would produce a negative window.
    expect(
      parseFilters({ range: "custom", from: "2026-05-09", to: "2026-05-01" }).range,
    ).toBe(30);
  });

  it("ignores an unknown event category", () => {
    expect(parseFilters({ events: "contact_intent" }).eventCategory).toBe("contact_intent");
    expect(parseFilters({ events: "made_up" }).eventCategory).toBeUndefined();
  });

  it("strips control characters and bounds length", () => {
    const filters = parseFilters({ path: `/a${String.fromCharCode(0)}b`.padEnd(400, "x") });
    expect(filters.path).not.toContain(String.fromCharCode(0));
    expect(filters.path!.length).toBeLessThanOrEqual(200);
  });

  it("treats an empty value as absent", () => {
    expect(parseFilters({ path: "   " }).path).toBeUndefined();
  });

  it("never produces a field that could name another site", () => {
    // The guarantee: a URL cannot select a site. The site is resolved from the
    // session, server-side. If this ever fails, one client is one URL edit away
    // from another client's figures.
    const filters = parseFilters({
      websiteId: "someone-elses-id",
      siteId: "someone-elses-id",
      website: "someone-elses-id",
    });
    expect(Object.keys(filters)).not.toContain("websiteId");
    expect(Object.keys(filters)).not.toContain("siteId");
    expect(JSON.stringify(filters)).not.toContain("someone-elses-id");
  });
});

describe("serialiseFilters", () => {
  it("writes nothing for the default view", () => {
    expect(serialiseFilters({ range: 30, compare: true })).toBe("");
  });

  it("round-trips through parse unchanged", () => {
    const original = {
      range: 7 as const,
      compare: false,
      path: "/work",
      referrer: "google.com",
      device: "mobile",
      country: "US",
      utmSource: "newsletter",
      utmCampaign: "spring",
      eventCategory: "contact_intent" as const,
    };
    const query = serialiseFilters(original);
    const params = Object.fromEntries(new URLSearchParams(query.slice(1)));
    expect(parseFilters(params)).toEqual(original);
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default view and true once anything narrows it", () => {
    expect(hasActiveFilters({ range: 30, compare: true })).toBe(false);
    expect(hasActiveFilters({ range: 7, compare: true })).toBe(true);
    expect(hasActiveFilters({ range: 30, compare: true, device: "mobile" })).toBe(true);
  });
});

describe("providerParams", () => {
  it("passes only dimensions the provider understands", () => {
    const params = providerParams({
      range: 30,
      compare: true,
      path: "/work",
      device: "mobile",
      eventCategory: "contact_intent",
    });
    expect(params).toEqual({ path: "/work", device: "mobile" });
    // A category is our grouping, not Umami's. Sent as an `event` filter it
    // would match nothing and return an empty panel that looked like silence.
    expect(params).not.toHaveProperty("eventCategory");
    expect(params).not.toHaveProperty("event");
  });
});

describe("windows", () => {
  it("sizes a preset window and marks its last day incomplete", () => {
    const now = new Date("2026-05-15T14:00:00Z");
    const window = resolveWindow({ range: 7, compare: true }, TZ, now);
    expect(window.days).toBe(7);
    // A trailing window always ends mid-day; comparing a part-finished day
    // against whole ones would report a decline every morning.
    expect(window.includesIncompleteDay).toBe(true);
  });

  it("makes a custom range inclusive of both dates", () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const window = resolveWindow(
      { range: "custom", customStart: "2026-05-01", customEnd: "2026-05-07", compare: true },
      TZ,
      now,
    );
    // Seven whole days, not six — an exclusive end would drop the last one.
    expect(window.days).toBe(7);
    expect(window.includesIncompleteDay).toBe(false);
  });

  it("puts the comparison window immediately before, with no overlap", () => {
    const now = new Date("2026-05-15T14:00:00Z");
    const window = resolveWindow({ range: 30, compare: true }, TZ, now);
    const prior = previousWindow(window);

    expect(prior.endAt).toBe(window.startAt);
    expect(prior.endAt - prior.startAt).toBe(window.endAt - window.startAt);
  });

  it("resolves midnight in the site timezone, not UTC", () => {
    // Denver is UTC-6 in May, so local midnight is 06:00 UTC. Using UTC
    // midnight would shift every figure by six hours and move activity across
    // day boundaries.
    const midnight = zonedDayStart("2026-05-01", TZ);
    expect(new Date(midnight).toISOString()).toBe("2026-05-01T06:00:00.000Z");
  });

  it("handles the winter offset too", () => {
    // Denver is UTC-7 in January. A fixed offset would be an hour out for half
    // the year, which nobody notices until a client asks why a Monday moved.
    const midnight = zonedDayStart("2026-01-15", TZ);
    expect(new Date(midnight).toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });
});

describe("cacheKey", () => {
  const window = { startAt: 1000, endAt: 2000, days: 1, includesIncompleteDay: false };

  it("differs between sites even when everything else matches", () => {
    // The failure this prevents: one client's figures served to another out of
    // a shared cache.
    const a = cacheKey("site-a", window, TZ, { range: 30, compare: true });
    const b = cacheKey("site-b", window, TZ, { range: 30, compare: true });
    expect(a).not.toBe(b);
    expect(a.startsWith("umami|site-a|")).toBe(true);
  });

  it("differs when the window, timezone, comparison or filters differ", () => {
    const base = cacheKey("site", window, TZ, { range: 30, compare: true });
    const otherWindow = cacheKey(
      "site",
      { ...window, endAt: 3000 },
      TZ,
      { range: 30, compare: true },
    );
    const otherZone = cacheKey("site", window, "Europe/London", { range: 30, compare: true });
    const noCompare = cacheKey("site", window, TZ, { range: 30, compare: false });
    const filtered = cacheKey("site", window, TZ, {
      range: 30,
      compare: true,
      device: "mobile",
    });

    expect(new Set([base, otherWindow, otherZone, noCompare, filtered]).size).toBe(5);
  });

  it("is stable regardless of the order filters were set", () => {
    const one = cacheKey("site", window, TZ, {
      range: 30,
      compare: true,
      device: "mobile",
      path: "/a",
    });
    const two = cacheKey("site", window, TZ, {
      range: 30,
      compare: true,
      path: "/a",
      device: "mobile",
    });
    // Otherwise the same view misses the cache half the time.
    expect(one).toBe(two);
  });
});
