import { afterEach, describe, expect, it, vi } from "vitest";
import {
  destinationFromInput,
  destinationUrl,
  newCampaignCode,
  normaliseCode,
  placementSource,
  shortLink,
  siteOrigin,
  utmCampaignSlug,
} from "@/lib/campaigns/links";

/**
 * The parts of a campaign that end up printed or in a URL.
 *
 * Two failures matter more than the rest: a short link that sends a
 * customer somewhere other than the client's own site (an open redirect
 * with the client's name on it), and a code that cannot be typed from a
 * yard sign. Both are pinned below.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("campaign codes", () => {
  it("makes six characters a person can read off a sign without confusing 0 and o", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newCampaignCode();
      expect(code).toMatch(/^[2-9a-hjkmnp-z]{6}$/);
    }
  });

  it("reads a code typed in capitals as the same code", () => {
    expect(normaliseCode(" 7KD2MX ")).toBe("7kd2mx");
  });

  it("refuses anything that is not a code, without touching the database", () => {
    expect(normaliseCode("")).toBeNull();
    expect(normaliseCode("../etc")).toBeNull();
    expect(normaliseCode("abc")).toBeNull();
    expect(normaliseCode("a".repeat(17))).toBeNull();
  });
});

describe("where a campaign sends people", () => {
  const origin = "https://acme.example";

  it("defaults to the home page", () => {
    expect(destinationFromInput("", origin)).toEqual({ ok: true, path: "/" });
    expect(destinationFromInput("   ", origin)).toEqual({ ok: true, path: "/" });
  });

  it("accepts a path, with or without the leading slash", () => {
    expect(destinationFromInput("/services/drains", origin)).toEqual({ ok: true, path: "/services/drains" });
    expect(destinationFromInput("spring-offer", origin)).toEqual({ ok: true, path: "/spring-offer" });
  });

  it("accepts a full address on their own site and keeps only the path", () => {
    expect(destinationFromInput("https://acme.example/offer?ref=1#book", origin)).toEqual({
      ok: true,
      path: "/offer?ref=1#book",
    });
    expect(destinationFromInput("https://www.acme.example/offer", origin)).toEqual({ ok: true, path: "/offer" });
  });

  it("refuses an address on anyone else's site", () => {
    expect(destinationFromInput("https://elsewhere.example/", origin).ok).toBe(false);
    expect(destinationFromInput("//elsewhere.example/", origin).ok).toBe(false);
    expect(destinationFromInput("/\\elsewhere.example", origin).ok).toBe(false);
    expect(destinationFromInput("javascript:alert(1)", origin).ok).toBe(false);
  });

  it("refuses control characters and absurd lengths", () => {
    expect(destinationFromInput("/a\nb", origin).ok).toBe(false);
    expect(destinationFromInput(`/${"a".repeat(400)}`, origin).ok).toBe(false);
  });
});

describe("the site's address", () => {
  it("prefers where the site actually serves", () => {
    expect(siteOrigin({ productionUrl: "https://acme.example/", primaryDomain: "old.example" })).toBe(
      "https://acme.example",
    );
  });

  it("falls back to the domain, over https", () => {
    expect(siteOrigin({ productionUrl: null, primaryDomain: "acme.example" })).toBe("https://acme.example");
    expect(siteOrigin({ productionUrl: "acme.example", primaryDomain: null })).toBe("https://acme.example");
  });

  it("is null when there is no address to send anyone to", () => {
    expect(siteOrigin({ productionUrl: null, primaryDomain: null })).toBeNull();
    expect(siteOrigin({ productionUrl: "javascript:alert(1)", primaryDomain: null })).toBeNull();
  });
});

describe("the redirect target", () => {
  it("tags the visit so the site's analytics can attribute it", () => {
    const url = new URL(
      destinationUrl({
        origin: "https://acme.example",
        path: "/offer",
        placement: "door_hangers",
        utmCampaign: "spring-hangers",
      }),
    );
    expect(url.origin).toBe("https://acme.example");
    expect(url.pathname).toBe("/offer");
    expect(url.searchParams.get("utm_source")).toBe("door-hangers");
    expect(url.searchParams.get("utm_medium")).toBe("qr");
    expect(url.searchParams.get("utm_campaign")).toBe("spring-hangers");
  });

  it("keeps the client's own query and anchor, and replaces any utm they typed", () => {
    const url = new URL(
      destinationUrl({
        origin: "https://acme.example",
        path: "/offer?ref=hanger&utm_source=mine#book",
        placement: "truck",
        utmCampaign: "van",
      }),
    );
    expect(url.searchParams.get("ref")).toBe("hanger");
    expect(url.searchParams.getAll("utm_source")).toEqual(["truck"]);
    expect(url.hash).toBe("#book");
  });

  it("never leaves the client's origin, whatever the stored path says", () => {
    const url = new URL(
      destinationUrl({ origin: "https://acme.example", path: "//evil.example/x", placement: "other", utmCampaign: "x" }),
    );
    expect(url.origin).toBe("https://acme.example");
  });

  it("names each placement in a form analytics tools display well", () => {
    expect(placementSource("business_cards")).toBe("business-cards");
    expect(placementSource("yard_signs")).toBe("yard-signs");
  });
});

describe("utm_campaign", () => {
  it("is a readable slug of the name", () => {
    expect(utmCampaignSlug("Spring Door Hangers — 2026!")).toBe("spring-door-hangers-2026");
    expect(utmCampaignSlug("Ñandú Café")).toBe("nandu-cafe");
  });

  it("is never empty and never long", () => {
    expect(utmCampaignSlug("!!!")).toBe("campaign");
    expect(utmCampaignSlug("a ".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("the short link", () => {
  it("lives on the portal by default", () => {
    vi.stubEnv("CAMPAIGN_LINK_BASE", "");
    vi.stubEnv("AUTH_URL", "https://portal.mortensenweb.com/");
    expect(shortLink("7kd2mx")).toBe("https://portal.mortensenweb.com/q/7kd2mx");
  });

  it("can move to a shorter host without code changes", () => {
    vi.stubEnv("CAMPAIGN_LINK_BASE", "https://mwc.to");
    expect(shortLink("7kd2mx")).toBe("https://mwc.to/q/7kd2mx");
  });
});
