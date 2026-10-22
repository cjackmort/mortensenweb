import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attributeCampaigns } from "@/lib/campaigns/attribution";

/**
 * Visits and contact taps per campaign, from the client's own analytics.
 *
 * The rule from the rest of the analytics code applies: "not connected",
 * "the service is down" and "nobody came" are three different answers, and
 * none of them may be drawn as a zero.
 */

const WINDOW = { startAt: 1_790_000_000_000, endAt: 1_792_592_000_000 };
const requested: URL[] = [];

function umamiResponds(byCampaign: Record<string, { visitors: number; events: { x: string; y: number }[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      requested.push(url);
      const figures = byCampaign[url.searchParams.get("utmCampaign") ?? ""] ?? { visitors: 0, events: [] };
      const body = url.pathname.endsWith("/stats")
        ? { visitors: figures.visitors, visits: figures.visitors, pageviews: figures.visitors }
        : figures.events;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

beforeEach(() => {
  requested.length = 0;
  vi.stubEnv("UMAMI_API_BASE_URL", "https://api.umami.example/v1");
  vi.stubEnv("UMAMI_API_KEY", "key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("attributing campaigns", () => {
  it("asks for each campaign's own utm_campaign and counts taps to get in touch", async () => {
    umamiResponds({
      "spring-hangers": {
        visitors: 14,
        events: [
          { x: "called", y: 3 },
          { x: "emailed", y: 1 },
          { x: "photo: Kitchen remodel", y: 9 },
        ],
      },
    });
    const state = await attributeCampaigns([{ utmCampaign: "spring-hangers", websiteId: "site-1" }], WINDOW);

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.byUtm["spring-hangers"]).toEqual({ visitors: 14, reachedOut: 4 });
    expect(requested.every((url) => url.searchParams.get("utmCampaign") === "spring-hangers")).toBe(true);
    expect(requested.every((url) => url.pathname.includes("/websites/site-1/"))).toBe(true);
  });

  it("leaves out a campaign whose site has no analytics, rather than reporting zero", async () => {
    umamiResponds({ a: { visitors: 2, events: [] } });
    const state = await attributeCampaigns(
      [
        { utmCampaign: "a", websiteId: "site-1" },
        { utmCampaign: "b", websiteId: null },
      ],
      WINDOW,
    );
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.byUtm.a).toEqual({ visitors: 2, reachedOut: 0 });
    expect(state.byUtm.b).toBeUndefined();
  });

  it("says analytics is not set up when the portal has no Umami account", async () => {
    vi.stubEnv("UMAMI_API_KEY", "");
    expect(await attributeCampaigns([{ utmCampaign: "a", websiteId: "site-1" }], WINDOW)).toEqual({
      kind: "not_configured",
    });
  });

  it("says the site is not connected when no campaign's site has a website id", async () => {
    expect(await attributeCampaigns([{ utmCampaign: "a", websiteId: null }], WINDOW)).toEqual({
      kind: "not_connected",
    });
  });

  it("reports a failure as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const state = await attributeCampaigns([{ utmCampaign: "a", websiteId: "site-1" }], WINDOW);
    expect(state).toEqual({ kind: "error", message: "Umami responded 500" });
  });

  it("asks about a bounded number of campaigns, so one page cannot exhaust the rate limit", async () => {
    umamiResponds({});
    const many = Array.from({ length: 20 }, (_, i) => ({ utmCampaign: `c${i}`, websiteId: "site-1" }));
    const state = await attributeCampaigns(many, WINDOW);
    expect(state.kind).toBe("ok");
    expect(requested.length).toBeLessThanOrEqual(16);
  });
});
