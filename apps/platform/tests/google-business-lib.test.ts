import { describe, expect, it } from "vitest";
import { openSecret, sealSecret, SealError } from "@/lib/google-business/seal";
import { errorFromResponse, GoogleApiError } from "@/lib/google-business/errors";
import {
  exchangeCode,
  grantsBusinessScope,
  refreshAccessToken,
  startAuthorization,
} from "@/lib/google-business/oauth";
import { createGoogleBusinessClient } from "@/lib/google-business/client";
import { periodsFromWeek, weekFromPeriods, originalReviewText } from "@/lib/google-business/normalize";
import {
  describeWeek,
  parseHoursForm,
  parseSpecialHoursForm,
} from "@/lib/google-business/hours";
import { holidaysIn, profileChecklist, profileGaps } from "@/lib/google-business/completeness";
import { draftReviewReply, firstName, mentionedService, servicesFrom } from "@/lib/google-business/reply-draft";
import { monthsForWindow, summarise, summariseSearches, syncRange } from "@/lib/google-business/metrics";
import { googleBusinessConfig } from "@/lib/google-business/config";
import type { ProfileSnapshot } from "@/lib/google-business/types";
import { fakeGoogle, QUOTA_ERROR, sampleLocation } from "./helpers/google-fake";

/**
 * The Google Business Profile library, against a fake Google at the HTTP
 * boundary. No database: everything here is the DB-free half that other
 * features will build on.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

const CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://portal.example/api/google/oauth/callback",
  tokenKey: KEY,
};

describe("sealing the refresh token", () => {
  it("round-trips, and never stores the plaintext", async () => {
    const sealed = await sealSecret("1//refresh-token", KEY);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("refresh-token");
    expect(await openSecret(sealed, KEY)).toBe("1//refresh-token");
  });

  it("uses a fresh nonce each time", async () => {
    expect(await sealSecret("same", KEY)).not.toBe(await sealSecret("same", KEY));
  });

  it("refuses the wrong key, a tampered value and a short key", async () => {
    const sealed = await sealSecret("secret", KEY);
    await expect(openSecret(sealed, OTHER_KEY)).rejects.toBeInstanceOf(SealError);

    const tampered = `${sealed.slice(0, -4)}AAAA`;
    await expect(openSecret(tampered, KEY)).rejects.toBeInstanceOf(SealError);

    await expect(sealSecret("x", Buffer.alloc(16).toString("base64"))).rejects.toThrow(/32 bytes/);
  });
});

describe("configuration", () => {
  it("names every missing variable and derives the redirect from AUTH_URL", () => {
    const saved = { ...process.env };
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_TOKEN_KEY;
      delete process.env.GOOGLE_REDIRECT_URI;
      process.env.AUTH_URL = "https://portal.example/";
      const check = googleBusinessConfig();
      expect(check).toEqual({
        ok: false,
        missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_KEY"],
        redirectUri: "https://portal.example/api/google/oauth/callback",
      });
    } finally {
      process.env = saved;
    }
  });
});

describe("Google's errors", () => {
  function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers });
  }

  it("reads a 429 as quota, with Google's retry-after", async () => {
    const error = await errorFromResponse(respond(429, QUOTA_ERROR, { "retry-after": "30" }));
    expect(error.kind).toBe("quota");
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("tells a disabled API from a missing permission", async () => {
    const disabled = await errorFromResponse(
      respond(403, {
        error: {
          code: 403,
          message: "My Business Business Information API has not been used in project 1 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "SERVICE_DISABLED" }],
        },
      }),
    );
    expect(disabled.kind).toBe("api_disabled");

    const denied = await errorFromResponse(
      respond(403, { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }),
    );
    expect(denied.kind).toBe("permission");
  });

  it("reads a revoked refresh token as auth", async () => {
    const error = await errorFromResponse(respond(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    expect(error.kind).toBe("auth");
  });
});

describe("OAuth", () => {
  it("asks for offline access with consent, the business scope and a PKCE challenge", async () => {
    const start = await startAuthorization(CONFIG);
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/business.manage");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(start.codeVerifier));
    const expected = Buffer.from(digest).toString("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a code with the verifier, and refreshes", async () => {
    const google = fakeGoogle();
    const grant = await exchangeCode(CONFIG, "the-code", "the-verifier", google.fetch);
    expect(grant.refreshToken).toBe("refresh-1");
    expect(grantsBusinessScope(grant.scope)).toBe(true);
    const sent = new URLSearchParams(String(google.calls[0]!.body));
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(sent.get("client_secret")).toBe("client-secret");

    const refreshed = await refreshAccessToken(CONFIG, "refresh-1", google.fetch);
    expect(refreshed.accessToken).toBe("access-1");
    expect(refreshed.refreshToken).toBeNull();

    await expect(refreshAccessToken(CONFIG, "revoked", google.fetch)).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("the client", () => {
  function setup() {
    const google = fakeGoogle();
    google.addLocation(sampleLocation("456"));
    const client = createGoogleBusinessClient("access-1", { fetch: google.fetch });
    return { google, client };
  }

  it("reads a profile into the portal's snapshot", async () => {
    const { client } = setup();
    const snapshot = await client.getLocation("locations/456");
    expect(snapshot).toMatchObject({
      title: "Acme Plumbing",
      phone: "(801) 555-0100",
      website: "https://acmeplumbing.example",
      primaryCategory: "Plumber",
      additionalCategories: ["Water heater installation service"],
      address: "12 Main St, Riverton, UT 84065",
      reviewUrl: "https://search.google.com/local/writereview?placeid=place-456",
      openStatus: "OPEN",
    });
    expect(snapshot.hours?.MONDAY).toEqual([{ open: "08:00", close: "17:00" }]);
    expect(snapshot.hours?.SUNDAY).toEqual([]);
  });

  it("patches only the masked field, then re-reads Google's version", async () => {
    const { google, client } = setup();
    const snapshot = await client.updateDescription("locations/456", "Plumbing and drains in Riverton.");
    const patch = google.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url.searchParams.get("updateMask")).toBe("profile.description");
    expect(patch.body).toEqual({ profile: { description: "Plumbing and drains in Riverton." } });
    expect(snapshot.description).toBe("Plumbing and drains in Riverton.");
    expect(snapshot.phone).toBe("(801) 555-0100");
  });

  it("refuses a resource name that is not one path segment", async () => {
    const { client, google } = setup();
    await expect(client.getLocation("locations/../accounts/1")).rejects.toBeInstanceOf(GoogleApiError);
    await expect(client.listReviews("accounts/111", "locations/4?x=1")).rejects.toBeInstanceOf(GoogleApiError);
    expect(google.calls).toHaveLength(0);
  });

  it("pages through reviews and maps ratings", async () => {
    const { google, client } = setup();
    for (let i = 0; i < 60; i += 1) {
      google.addReview("locations/456", {
        reviewId: `r${i}`,
        reviewer: { displayName: `Customer ${i}` },
        starRating: i % 2 ? "FIVE" : "TWO",
        comment: "Good",
        createTime: "2026-10-01T10:00:00Z",
      });
    }
    const first = await client.listReviews("accounts/111", "locations/456");
    expect(first.reviews).toHaveLength(50);
    expect(first.nextPageToken).not.toBeNull();
    const second = await client.listReviews("accounts/111", "locations/456", first.nextPageToken);
    expect(second.reviews).toHaveLength(10);
    expect(second.nextPageToken).toBeNull();
    expect(first.reviews[1]!.starRating).toBe(5);
    expect(first.reviews[0]!.starRating).toBe(2);
    expect(first.totalReviewCount).toBe(60);
  });

  it("sends a post with its photo and call to action", async () => {
    const { google, client } = setup();
    const post = await client.createPost("accounts/111", "locations/456", {
      summary: "Fall furnace tune-ups are booking now.",
      photoUrl: "https://portal.example/api/media/agent/token",
      cta: { type: "BOOK", url: "https://acmeplumbing.example/book" },
    });
    expect(post.name).toMatch(/localPosts\/1$/);
    const sent = google.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/localPosts"))!;
    expect(sent.url.pathname).toBe("/v4/accounts/111/locations/456/localPosts");
    expect(sent.body).toMatchObject({
      summary: "Fall furnace tune-ups are booking now.",
      topicType: "STANDARD",
      callToAction: { actionType: "BOOK", url: "https://acmeplumbing.example/book" },
      media: [{ mediaFormat: "PHOTO", sourceUrl: "https://portal.example/api/media/agent/token" }],
    });
  });

  it("fills Google's omitted zeros in daily figures", async () => {
    const { google, client } = setup();
    google.setMetric("locations/456", "2026-10-01", "CALL_CLICKS", 3);
    google.setMetric("locations/456", "2026-10-01", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", 40);
    google.setMetric("locations/456", "2026-10-01", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", 10);
    google.setMetric("locations/456", "2026-10-02", "WEBSITE_CLICKS", 0);
    const rows = await client.dailyMetrics("locations/456", { start: "2026-10-01", end: "2026-10-02" });
    expect(rows).toEqual([
      { date: "2026-10-01", searchViews: 50, mapsViews: 0, calls: 3, websiteClicks: 0, directionRequests: 0 },
      { date: "2026-10-02", searchViews: 0, mapsViews: 0, calls: 0, websiteClicks: 0, directionRequests: 0 },
    ]);
  });

  it("keeps search counts below Google's threshold as thresholds", async () => {
    const { google, client } = setup();
    google.setKeywords("locations/456", "2026-09", [
      { keyword: "plumber riverton", value: 120 },
      { keyword: "emergency plumber", threshold: 15 },
    ]);
    expect(await client.searchKeywords("locations/456", "2026-09-01")).toEqual([
      { keyword: "plumber riverton", impressions: 120, belowThreshold: null },
      { keyword: "emergency plumber", impressions: null, belowThreshold: 15 },
    ]);
  });

  it("raises quota errors rather than retrying", async () => {
    const { google, client } = setup();
    google.failWhen(() => true, 429, QUOTA_ERROR);
    await expect(client.getLocation("locations/456")).rejects.toMatchObject({ kind: "quota" });
    expect(google.calls).toHaveLength(1);
  });
});

describe("hours", () => {
  it("keeps an overnight range on the day it opens, and writes it back across midnight", () => {
    const week = weekFromPeriods([
      { openDay: "FRIDAY", openTime: { hours: 18 }, closeDay: "SATURDAY", closeTime: { hours: 2 } },
      { openDay: "SUNDAY", openTime: {}, closeDay: "SUNDAY", closeTime: { hours: 24 } },
    ])!;
    expect(week.FRIDAY).toEqual([{ open: "18:00", close: "02:00" }]);
    expect(week.SUNDAY).toEqual([{ open: "00:00", close: "24:00" }]);
    const periods = periodsFromWeek(week);
    expect(periods[0]).toMatchObject({ openDay: "FRIDAY", closeDay: "SATURDAY" });
    expect(periods[1]).toMatchObject({ openDay: "SUNDAY", closeDay: "SUNDAY", closeTime: { hours: 24, minutes: 0 } });
  });

  it("reads the week form, joining identical days for display", () => {
    const form = new FormData();
    for (const day of ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]) {
      form.set(`${day}.mode`, "open");
      form.set(`${day}.0.open`, "08:00");
      form.set(`${day}.0.close`, "17:00");
    }
    form.set("SATURDAY.mode", "open");
    form.set("SATURDAY.0.open", "09:00");
    form.set("SATURDAY.0.close", "12:00");
    form.set("SATURDAY.1.open", "13:00");
    form.set("SATURDAY.1.close", "16:30");
    form.set("SUNDAY.mode", "closed");

    const parsed = parseHoursForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(describeWeek(parsed.value)).toEqual([
      { days: "Mon–Fri", hours: "8 am – 5 pm" },
      { days: "Sat", hours: "9 am – 12 pm, 1 pm – 4:30 pm" },
      { days: "Sun", hours: "Closed" },
    ]);
  });

  it("says what is wrong with the week form, by day", () => {
    const form = new FormData();
    form.set("MONDAY.mode", "open");
    form.set("MONDAY.0.open", "08:00");
    form.set("MONDAY.0.close", "12:00");
    form.set("MONDAY.1.open", "11:00");
    form.set("MONDAY.1.close", "15:00");
    form.set("TUESDAY.mode", "open");
    for (const day of ["WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]) form.set(`${day}.mode`, "closed");
    const parsed = parseHoursForm(form);
    expect(parsed).toEqual({
      ok: false,
      errors: ["Monday: the two time ranges overlap.", "Tuesday: enter its hours, or mark it closed."],
    });
  });

  it("reads special hours, skipping removed and empty rows", () => {
    const form = new FormData();
    form.set("special.0.date", "2026-11-26");
    form.set("special.0.mode", "closed");
    form.set("special.1.date", "2026-12-24");
    form.set("special.1.mode", "open");
    form.set("special.1.open", "08:00");
    form.set("special.1.close", "12:00");
    form.set("special.2.date", "2026-07-04");
    form.set("special.2.mode", "remove");
    expect(parseSpecialHoursForm(form, 5)).toEqual({
      ok: true,
      value: [
        { date: "2026-11-26", closed: true },
        { date: "2026-12-24", closed: false, open: "08:00", close: "12:00" },
      ],
    });
  });
});

function snapshot(overrides: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    title: "Acme Plumbing",
    phone: "(801) 555-0100",
    website: "https://acmeplumbing.example",
    primaryCategory: "Plumber",
    additionalCategories: [],
    description: "Plumbing in Riverton.",
    address: null,
    hours: weekFromPeriods([{ openDay: "MONDAY", openTime: { hours: 8 }, closeDay: "MONDAY", closeTime: { hours: 17 } }]),
    specialHours: [],
    openStatus: "OPEN",
    mapsUrl: null,
    reviewUrl: null,
    placeId: null,
    hasPendingEdits: false,
    ...overrides,
  };
}

describe("completeness", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  it("knows when the US holidays fall", () => {
    expect(holidaysIn(2026).find((h) => h.name === "Thanksgiving")?.date).toBe("2026-11-26");
    expect(holidaysIn(2026).find((h) => h.name === "Memorial Day")?.date).toBe("2026-05-25");
    expect(holidaysIn(2026).find((h) => h.name === "Labor Day")?.date).toBe("2026-09-07");
  });

  it("lists exactly what is missing", () => {
    const gaps = profileGaps({
      snapshot: snapshot({ website: null }),
      photoCount: 2,
      lastPostAt: new Date("2026-09-01T00:00:00Z"),
      unansweredReviews: 1,
      now,
    });
    expect(gaps.map((g) => g.key)).toEqual(["website", "photos", "post", "reviews", "holiday"]);
    expect(gaps.find((g) => g.key === "holiday")?.detail).toContain("Thanksgiving (2026-11-26)");
    expect(gaps.find((g) => g.key === "post")?.detail).toBe("Last post 59 days ago.");
  });

  it("is satisfied by special hours for the coming holiday", () => {
    const items = profileChecklist({
      snapshot: snapshot({ specialHours: [{ date: "2026-11-26", closed: true }] }),
      photoCount: 8,
      lastPostAt: new Date("2026-10-25T00:00:00Z"),
      unansweredReviews: 0,
      now,
    });
    expect(items.every((i) => i.done)).toBe(true);
  });
});

describe("reply drafts", () => {
  const business = {
    name: "Acme Plumbing",
    phone: "(801) 555-0100",
    email: null,
    services: servicesFrom("Drain cleaning – from $150\nWater heater installs\nLeak repair"),
  };

  it("uses a real first name, and none for an anonymous or initialled reviewer", () => {
    expect(firstName("dana smith")).toBe("Dana");
    expect(firstName("A Google User")).toBeNull();
    expect(firstName("J. S.")).toBeNull();
    expect(firstName(null)).toBeNull();
  });

  it("names a service only when the review mentions it", () => {
    expect(mentionedService("They did our water heater installs fast", business.services)).toBe("water heater installs");
    expect(mentionedService("Fixed a leak repair quickly", business.services)).toBe("leak repair");
    expect(mentionedService("Great people", business.services)).toBeNull();
  });

  it("thanks a happy reviewer without inventing anything", () => {
    const reply = draftReviewReply(
      { reviewId: "abc", reviewerName: "Dana Smith", starRating: 5, comment: "Drain cleaning was quick and tidy." },
      business,
    );
    expect(reply).toContain("Dana");
    expect(reply).toContain("drain cleaning");
    expect(reply).toMatch(/— Acme Plumbing$/);
    expect(reply).not.toMatch(/\$|years|refund|discount/i);
  });

  it("gives an unhappy reviewer the public phone number and no excuses", () => {
    const reply = draftReviewReply(
      { reviewId: "xyz", reviewerName: "A Google User", starRating: 1, comment: "Never showed up." },
      business,
    );
    expect(reply).toContain("(801) 555-0100");
    expect(reply).toMatch(/sorry/i);
    expect(reply).not.toContain("showed up");
  });

  it("falls back to email, then to 'get in touch', when there is no phone", () => {
    expect(
      draftReviewReply({ reviewId: "1", reviewerName: null, starRating: 3, comment: null }, { ...business, phone: null, email: "hi@acme.example" }),
    ).toContain("hi@acme.example");
    expect(
      draftReviewReply({ reviewId: "1", reviewerName: null, starRating: 2, comment: null }, { ...business, phone: null }),
    ).toContain("get in touch");
  });

  it("never doubles the full stop after a business name ending in one", () => {
    const voice = { ...business, name: "Riverton Plumbing Co." };
    for (const reviewId of ["a", "b", "c", "d", "e", "f"]) {
      const reply = draftReviewReply({ reviewId, reviewerName: "Dana", starRating: 5, comment: "Great." }, voice);
      expect(reply).not.toContain("..");
    }
  });

  it("strips Google's machine translation and keeps the original", () => {
    expect(originalReviewText("Great work (Translated by Google) Buen trabajo")).toBe("Great work");
    expect(originalReviewText("(Translated by Google) Great work (Original) Buen trabajo")).toBe("Buen trabajo");
  });
});

describe("metrics", () => {
  it("has no summary without figures — never zeros", () => {
    expect(summarise([], 30)).toEqual({ state: "none" });
  });

  it("ends the window at the newest day Google reported", () => {
    // August 1–31 and September 1–30: the 30-day window is September alone.
    const rows = [
      ...Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
    ].map((date) => ({ date, searchViews: 1, mapsViews: 2, calls: 1, websiteClicks: 0, directionRequests: 0 }));
    const summary = summarise(rows, 30);
    expect(summary).toMatchObject({
      state: "ok",
      range: { start: "2026-09-01", end: "2026-09-30" },
      daysReported: 30,
      totals: { views: 90, searchViews: 30, mapsViews: 60, calls: 30 },
    });
  });

  it("requests the last 100 days ending yesterday", () => {
    expect(syncRange(new Date("2026-10-20T08:00:00Z"))).toEqual({ start: "2026-07-12", end: "2026-10-19" });
  });

  it("totals search terms as a floor when some are below the threshold", () => {
    const summary = summariseSearches(
      [
        { month: "2026-08-01", keyword: "plumber", impressions: 50, belowThreshold: null },
        { month: "2026-09-01", keyword: "plumber", impressions: 70, belowThreshold: null },
        { month: "2026-09-01", keyword: "drain", impressions: null, belowThreshold: 15 },
      ],
      monthsForWindow(["2026-08-01", "2026-09-01"], 90),
    )!;
    expect(summary.atLeast).toBe(120);
    expect(summary.hasHidden).toBe(true);
    expect(summary.top).toEqual([{ keyword: "plumber", impressions: 120, belowThreshold: null }]);
    expect(monthsForWindow(["2026-07-01", "2026-08-01", "2026-09-01"], 30)).toEqual(["2026-09-01"]);
  });
});
