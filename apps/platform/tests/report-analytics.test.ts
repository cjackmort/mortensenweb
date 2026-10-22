import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthAnalytics } from "@/lib/reports/analytics";
import { reportWindow } from "@/lib/reports/period";

/**
 * A month of one site's analytics, as the report reads it.
 *
 * Umami is replaced by a fetch stub that answers by path and window, so each
 * test can make one call fail or return nothing without touching the rest.
 */

const SEPTEMBER = reportWindow("2026-09", "America/Denver");
const AUGUST = reportWindow("2026-08", "America/Denver");
const WEBSITE = "4f5eaf4e-5e3e-4545-b742-d2fb05e1a911";

type Handler = (url: URL) => unknown;

function stubUmami(overrides: Partial<Record<"stats" | "priorStats" | "pageviews" | "url" | "referrer" | "event" | "history", Handler>> = {}) {
  const handlers: Record<string, Handler> = {
    stats: () => ({ visitors: 312, visits: 400, pageviews: 801, bounces: 100, totaltime: 40000 }),
    priorStats: () => ({ visitors: { value: 264 } }),
    pageviews: () => ({ pageviews: [{ x: "2026-09-01", y: 20 }], sessions: [{ x: "2026-09-01", y: 10 }] }),
    url: () => [
      { x: "/", y: 400 },
      { x: "/services", y: 200 },
      { x: "/contact", y: 90 },
      { x: "/about", y: 50 },
      { x: "/gallery", y: 30 },
      { x: "/blog", y: 20 },
    ],
    referrer: () => [{ x: "google.com", y: 150 }, { x: null, y: 80 }],
    device: () => [],
    country: () => [],
    event: () => [
      { x: "called", y: 21 },
      { x: "Called", y: 2 },
      { x: "photo: Kitchen", y: 9 },
      { x: "portal:upload", y: 5 },
    ],
    history: () => [{ x: "called", y: 140 }, { x: "emailed", y: 12 }],
    ...overrides,
  };

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const startAt = Number(url.searchParams.get("startAt"));
    const isSeptember = startAt === SEPTEMBER.startAt.getTime();
    let key: string;
    if (url.pathname.endsWith("/stats")) key = isSeptember ? "stats" : "priorStats";
    else if (url.pathname.endsWith("/pageviews")) key = "pageviews";
    else {
      const type = url.searchParams.get("type") ?? "";
      key = type === "event" && !isSeptember ? "history" : type;
    }
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected Umami call ${url.pathname}?${url.searchParams}`);
    const body = handler(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("BUSINESS_TIMEZONE", "America/Denver");
  vi.stubEnv("UMAMI_API_BASE_URL", "https://umami.example.test");
  vi.stubEnv("UMAMI_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a connected site", () => {
  it("reads visitors, the calendar-month trend, top pages and sources", async () => {
    stubUmami();
    const { visitors } = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);

    expect(visitors).toMatchObject({ state: "ok", visitors: 312, pageviews: 801, previousVisitors: 264 });
    if (visitors.state !== "ok") throw new Error("expected figures");
    expect(visitors.change).toBeCloseTo((312 - 264) / 264);
    expect(visitors.topPages.map((p) => p.label)).toEqual(["/", "/services", "/contact", "/about", "/gallery"]);
    expect(visitors.sources).toEqual([
      { label: "google.com", value: 150 },
      { label: "(direct)", value: 80 },
    ]);
  });

  it("asks Umami for the calendar month, not a trailing window", async () => {
    const fetchMock = stubUmami();
    await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);

    const statsCalls = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/stats"));
    const windows = statsCalls.map((url) => [Number(url.searchParams.get("startAt")), Number(url.searchParams.get("endAt"))]);
    expect(windows).toContainEqual([SEPTEMBER.startAt.getTime(), SEPTEMBER.endAt.getTime()]);
    expect(windows).toContainEqual([AUGUST.startAt.getTime(), AUGUST.endAt.getTime()]);
  });

  it("counts taps by event, merging case, and ignores portal and content events", async () => {
    stubUmami();
    const { contact } = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    // The email link is tracked (seen this year) and nobody tapped it this
    // month: a real zero. Booking was never seen: absent, not zero.
    expect(contact).toEqual({
      state: "ok",
      rows: [
        { id: "phone_tapped", count: 23 },
        { id: "email_tapped", count: 0 },
      ],
    });
  });

  it("says taps are not tracked when the site has never reported one", async () => {
    stubUmami({ event: () => [{ x: "photo: Kitchen", y: 9 }], history: () => [{ x: "photo: Kitchen", y: 90 }] });
    const { contact } = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    expect(contact).toEqual({ state: "missing", reason: "not_tracked" });
  });

  it("will not call a quiet month untracked when it could not read the history", async () => {
    stubUmami({ event: () => [], history: () => new Response("", { status: 500 }) });
    const { contact } = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    expect(contact).toEqual({ state: "missing", reason: "failed" });
  });

  it("keeps the figures and drops only the trend when last month fails", async () => {
    stubUmami({ priorStats: () => new Response("", { status: 503 }) });
    const { visitors } = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    expect(visitors).toMatchObject({ state: "ok", visitors: 312, previousVisitors: null, change: null });
  });

  it("reports a genuine zero as zero", async () => {
    stubUmami({
      stats: () => ({ visitors: 0, visits: 0, pageviews: 0, bounces: 0, totaltime: 0 }),
      url: () => [],
      referrer: () => [],
      event: () => [],
    });
    const { visitors } = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    expect(visitors).toMatchObject({ state: "ok", visitors: 0 });
  });
});

describe("a site whose figures are not available", () => {
  it("is not configured when the portal has no Umami account", async () => {
    vi.stubEnv("UMAMI_API_KEY", "");
    const fetchMock = stubUmami();
    const result = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    expect(result.visitors).toEqual({ state: "missing", reason: "analytics_not_configured" });
    expect(result.contact).toEqual({ state: "missing", reason: "analytics_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not connected when the site has no website id", async () => {
    stubUmami();
    const result = await monthAnalytics(null, SEPTEMBER, AUGUST);
    expect(result.visitors).toEqual({ state: "missing", reason: "analytics_not_connected" });
  });

  it("is an error, never zero, when the provider fails", async () => {
    stubUmami({ stats: () => new Response("", { status: 500 }) });
    const result = await monthAnalytics(WEBSITE, SEPTEMBER, AUGUST);
    expect(result.visitors).toEqual({ state: "missing", reason: "analytics_error" });
    expect(result.contact).toEqual({ state: "missing", reason: "analytics_error" });
  });
});
