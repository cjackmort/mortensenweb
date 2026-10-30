import { describe, expect, it } from "vitest";
import { bookingOriginAllowed, groupByDay, parseBookingRequest } from "@/lib/availability/public";
import { parseOverride, parseRules, parseWeeklyHours, readStoredRanges } from "@/lib/availability/rules";
import { formatDuration, timeZoneLabel } from "@/lib/availability/format";
import {
  CALENDAR_FREEBUSY_SCOPE,
  exchangeCalendarCode,
  freeBusyWindows,
  googleCalendarConfig,
} from "@/lib/connections/providers/google-calendar";
import { ProviderError } from "@/lib/connections/types";

/**
 * The pure edges of booking: what a public request may contain, which pages
 * may send one, what the forms accept, and what the calendar connection asks
 * Google for.
 */

const START = "2026-10-19T15:00:00.000Z";

describe("a booking request from the website", () => {
  it("reads a good request, trimming and lower-casing the email", () => {
    const parsed = parseBookingRequest({ start: START, name: " Dana ", email: " Dana@Example.COM ", phone: "", note: "" });
    expect(parsed).toEqual({
      ok: true,
      request: { start: new Date(START), name: "Dana", email: "dana@example.com", phone: null, note: null },
    });
  });

  it("says what is wrong in the customer's words", () => {
    expect(parseBookingRequest({ start: START, name: "", email: "d@example.com" })).toEqual({ ok: false, message: "Tell us your name." });
    expect(parseBookingRequest({ start: START, name: "D", email: "not-an-email" })).toEqual({
      ok: false,
      message: "Check your email address.",
    });
    expect(parseBookingRequest({ start: "tomorrow", name: "D", email: "d@example.com" })).toEqual({ ok: false, message: "Pick a time." });
    expect(parseBookingRequest({ start: START, name: "D", email: "d@example.com", phone: "call me maybe" })).toEqual({
      ok: false,
      message: "Check your phone number.",
    });
    expect(parseBookingRequest(null)).toMatchObject({ ok: false });
    expect(parseBookingRequest([])).toMatchObject({ ok: false });
  });

  it("drops a request that filled the hidden field, without saying so", () => {
    expect(parseBookingRequest({ start: START, name: "Bot", email: "b@example.com", company: "ACME SEO" })).toEqual({ ok: "bot" });
  });

  it("keeps a name to one line", () => {
    const parsed = parseBookingRequest({ start: START, name: "Dana\r\nBcc: x@example.com", email: "d@example.com" });
    expect(parsed.ok === true && parsed.request.name).toBe("Dana Bcc: x@example.com");
  });
});

describe("where a booking may come from", () => {
  const origins = ["https://acme.example", "https://www.acme.example"];
  it("allows the site's own origins and requests with no origin", () => {
    expect(bookingOriginAllowed("https://acme.example", origins, false)).toBe(true);
    expect(bookingOriginAllowed(null, origins, false)).toBe(true);
    expect(bookingOriginAllowed("https://acme.example.evil.test", origins, false)).toBe(false);
    expect(bookingOriginAllowed("http://localhost:4331", origins, false)).toBe(false);
    expect(bookingOriginAllowed("http://localhost:4331", origins, true)).toBe(true);
    expect(bookingOriginAllowed("https://localhost:4331", [], true)).toBe(false);
  });
});

describe("the feed's days", () => {
  it("lists every date in the window, empty where nothing is open", () => {
    const days = groupByDay(
      [{ start: new Date(START), end: new Date("2026-10-19T16:00:00.000Z"), date: "2026-10-19" }],
      "2026-10-18",
      "2026-10-20",
    );
    expect(days.map((d) => [d.date, d.slots.length])).toEqual([
      ["2026-10-18", 0],
      ["2026-10-19", 1],
      ["2026-10-20", 0],
    ]);
  });
});

describe("the forms", () => {
  it("reads the approval checkbox by presence", () => {
    const base = { timeZone: "America/Denver", slotMinutes: "30", bufferMinutes: "10", minNoticeMinutes: "60", horizonDays: "30" };
    expect(parseRules({ ...base, requiresApproval: "on" })).toMatchObject({ ok: true, value: { requiresApproval: true, slotMinutes: 30 } });
    expect(parseRules({ ...base, requiresApproval: null })).toMatchObject({ ok: true, value: { requiresApproval: false } });
    expect(parseRules({ ...base, horizonDays: "365", requiresApproval: null })).toEqual({ ok: false, message: "Offer up to 90 days ahead." });
  });

  it("reads a week, treating an end of 00:00 as midnight", () => {
    const parsed = parseWeeklyHours({ 5: [{ start: "18:00", end: "00:00" }] });
    expect(parsed.ok && parsed.value[5]).toEqual([{ start: 1080, end: 1440 }]);
    expect(parsed.ok && parsed.value[0]).toEqual([]);
    expect(parseWeeklyHours("{not json")).toMatchObject({ ok: false });
    expect(parseWeeklyHours({ 7: [] })).toMatchObject({ ok: false });
    expect(parseWeeklyHours({ 1: [{ start: "9am", end: "5pm" }] })).toMatchObject({ ok: false });
  });

  it("reads a day off or a day's own hours", () => {
    expect(parseOverride({ date: "2026-12-25", mode: "closed", start: "", end: "" }, "2026-10-19")).toEqual({
      ok: true,
      value: { date: "2026-12-25", ranges: [] },
    });
    expect(parseOverride({ date: "2026-12-24", mode: "hours", start: "09:00", end: "12:00" }, "2026-10-19")).toEqual({
      ok: true,
      value: { date: "2026-12-24", ranges: [{ start: 540, end: 720 }] },
    });
    expect(parseOverride({ date: "2026-02-30", mode: "closed", start: "", end: "" }, "2026-01-01")).toMatchObject({ ok: false });
  });

  it("ignores stored ranges that could not have been saved", () => {
    expect(readStoredRanges([{ start: 540, end: 600 }, { start: 600, end: 500 }, "x", null])).toEqual([{ start: 540, end: 600 }]);
    expect(readStoredRanges({})).toEqual([]);
  });

  it("says durations and zones plainly", () => {
    expect([0, 45, 60, 120, 90, 1440, 2880, 10080].map(formatDuration)).toEqual([
      "None",
      "45 minutes",
      "1 hour",
      "2 hours",
      "1 hour 30 minutes",
      "1 day",
      "2 days",
      "1 week",
    ]);
    expect(timeZoneLabel("America/Denver")).toBe("Mountain Time");
  });
});

describe("the Google Calendar connection", () => {
  it("needs the same Google client as Search Console, with its own callback", () => {
    expect(googleCalendarConfig({})).toEqual({
      ok: false,
      missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AUTH_URL", "CONNECTION_TOKEN_KEY"],
    });
    const ok = googleCalendarConfig({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      AUTH_URL: "https://portal.example/",
      CONNECTION_TOKEN_KEY: "key",
    });
    expect(ok.ok && ok.config.redirectUri).toBe("https://portal.example/api/connections/google_calendar/callback");
  });

  it("asks Google about a long window a month at a time", () => {
    const windows = freeBusyWindows(new Date("2026-10-19T00:00:00Z"), new Date("2027-01-17T00:00:00Z"));
    expect(windows.map((w) => w.from.toISOString().slice(0, 10))).toEqual(["2026-10-19", "2026-11-19", "2026-12-20"]);
    expect(windows.at(-1)!.to.toISOString()).toBe("2027-01-17T00:00:00.000Z");
  });

  it("refuses a sign-in where the calendar box was unticked", async () => {
    const config = { clientId: "id", clientSecret: "s", redirectUri: "https://p.example/cb", tokenKey: "k" };
    const fetchImpl = (async () =>
      Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email" })) as typeof fetch;
    await expect(exchangeCalendarCode(config, "code", "verifier", fetchImpl)).rejects.toBeInstanceOf(ProviderError);

    const granted = (async (url: string | URL) =>
      String(url).includes("userinfo")
        ? Response.json({ sub: "sub-1", email: "owner@acme.example" })
        : Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: `openid email ${CALENDAR_FREEBUSY_SCOPE}` })) as typeof fetch;
    expect(await exchangeCalendarCode(config, "code", "verifier", granted)).toMatchObject({
      externalId: "sub-1",
      displayName: "owner@acme.example",
      refreshToken: "r",
    });
  });
});
