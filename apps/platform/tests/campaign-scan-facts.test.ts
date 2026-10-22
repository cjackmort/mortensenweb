import { describe, expect, it } from "vitest";
import { coarsePlace, createRateLimiter, deviceClass, visitorHash } from "@/lib/campaigns/scan-facts";

/**
 * What a scan records about the person scanning: a device class, a town,
 * and a hash that cannot be turned back into who they were.
 */

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("device class", () => {
  it("tells phones, tablets and computers apart", () => {
    expect(deviceClass(headers({ "user-agent": IPHONE }))).toBe("mobile");
    expect(deviceClass(headers({ "user-agent": ANDROID_PHONE }))).toBe("mobile");
    expect(deviceClass(headers({ "user-agent": IPAD }))).toBe("tablet");
    expect(deviceClass(headers({ "user-agent": ANDROID_TABLET }))).toBe("tablet");
    expect(deviceClass(headers({ "user-agent": WINDOWS }))).toBe("desktop");
  });

  it("believes the browser's own mobile hint", () => {
    expect(deviceClass(headers({ "user-agent": "Mozilla/5.0", "sec-ch-ua-mobile": "?1" }))).toBe("mobile");
  });

  it("marks link previews and scripts as bots, so they are never counted as scans", () => {
    expect(deviceClass(headers({ "user-agent": "facebookexternalhit/1.1" }))).toBe("bot");
    expect(deviceClass(headers({ "user-agent": "Slackbot-LinkExpanding 1.0" }))).toBe("bot");
    expect(deviceClass(headers({ "user-agent": "WhatsApp/2.24.1 A" }))).toBe("bot");
    expect(deviceClass(headers({ "user-agent": "curl/8.4.0" }))).toBe("bot");
    expect(deviceClass(headers({ "user-agent": "Googlebot/2.1" }))).toBe("bot");
  });

  it("says unknown rather than guessing", () => {
    expect(deviceClass(headers({}))).toBe("unknown");
  });
});

describe("coarse place", () => {
  const geo = {
    city: "Riverton",
    country: { code: "US", name: "United States" },
    subdivision: { code: "UT", name: "Utah" },
    latitude: 40.52,
    longitude: -111.94,
    postalCode: "84065",
    timezone: "America/Denver",
  };

  it("reads Netlify's geo header and keeps only town, state and country", () => {
    const encoded = Buffer.from(JSON.stringify(geo)).toString("base64");
    expect(coarsePlace(headers({ "x-nf-geo": encoded }))).toEqual({
      city: "Riverton",
      region: "UT",
      country: "US",
    });
  });

  it("accepts the header as plain JSON too", () => {
    expect(coarsePlace(headers({ "x-nf-geo": JSON.stringify(geo) })).city).toBe("Riverton");
  });

  it("falls back to the country header alone", () => {
    expect(coarsePlace(headers({ "x-country": "us" }))).toEqual({ city: null, region: null, country: "US" });
  });

  it("records nothing rather than something wrong", () => {
    expect(coarsePlace(headers({ "x-nf-geo": "not base64 json" }))).toEqual({
      city: null,
      region: null,
      country: null,
    });
    const odd = Buffer.from(JSON.stringify({ city: "x".repeat(500), country: { code: "USA!" } })).toString("base64");
    expect(coarsePlace(headers({ "x-nf-geo": odd }))).toEqual({ city: null, region: null, country: null });
  });
});

describe("visitor hash", () => {
  const day = new Date("2026-10-20T15:00:00Z");

  it("is the same for one visitor on one day", async () => {
    const a = await visitorHash("secret", "203.0.113.9", IPHONE, day);
    const b = await visitorHash("secret", "203.0.113.9", IPHONE, new Date("2026-10-20T23:59:00Z"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("cannot link one day's scans to the next", async () => {
    const today = await visitorHash("secret", "203.0.113.9", IPHONE, day);
    const tomorrow = await visitorHash("secret", "203.0.113.9", IPHONE, new Date("2026-10-21T01:00:00Z"));
    expect(today).not.toBe(tomorrow);
  });

  it("does not contain the address", async () => {
    const hash = await visitorHash("secret", "203.0.113.9", IPHONE, day);
    expect(hash).not.toContain("203");
  });

  it("is null without an address or a key, rather than one shared bucket", async () => {
    expect(await visitorHash("secret", undefined, IPHONE, day)).toBeNull();
    expect(await visitorHash(undefined, "203.0.113.9", IPHONE, day)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("allows a burst up to the limit, then refuses until the window passes", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const t = 1_000_000;
    expect(limiter.hit("a", t)).toBe(true);
    expect(limiter.hit("a", t + 1)).toBe(true);
    expect(limiter.hit("a", t + 2)).toBe(true);
    expect(limiter.hit("a", t + 3)).toBe(false);
    // Someone else is unaffected.
    expect(limiter.hit("b", t + 3)).toBe(true);
    expect(limiter.hit("a", t + 60_001)).toBe(true);
  });

  it("does not grow without bound", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i += 1) limiter.hit(`k${i}`, 1_000);
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });
});
