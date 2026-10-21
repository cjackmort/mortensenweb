import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { fetchGoogleAdsStats, googleAdsConfigured, placeLabel } from "@/lib/ads/google-ads";
import { fetchMetaStats, metaConfigured } from "@/lib/ads/meta";
import { googlePlacement, metaPlacement, placementFor } from "@/lib/ads/placements";
import { AdsApiError } from "@/lib/ads/stats";
import { buildReport, TOP_LOCATIONS, type StoredStat } from "@/lib/ads/report";

/**
 * The two platform clients and the report built from what they return.
 *
 * Neither can be run against a real account in a test, so each is driven by a
 * fake `fetch` that answers in the documented response shape and records what
 * it was asked. The checks are on the requests (the right ids, versions,
 * headers and breakdowns) and on the parsing (int64 strings, micros, decimal
 * spend, overlapping Meta action types).
 */

const GOOGLE_ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
  GOOGLE_ADS_CLIENT_ID: "client",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
};

const META_ENV = { META_SYSTEM_USER_TOKEN: "meta-token", META_APP_SECRET: "app-secret" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("placements", () => {
  it("maps Google networks, including Maps and the retired YouTube types", () => {
    expect(googlePlacement("SEARCH")).toBe("google_search");
    expect(googlePlacement("MAPS")).toBe("google_maps");
    expect(googlePlacement("CONTENT")).toBe("display_network");
    expect(googlePlacement("YOUTUBE_WATCH")).toBe("youtube");
    expect(googlePlacement("SOMETHING_NEW")).toBe("google_something_new");
  });

  it("maps Meta platforms and positions", () => {
    expect(metaPlacement("facebook", "feed")).toBe("facebook_feed");
    expect(metaPlacement("instagram", "stream")).toBe("instagram_feed");
    expect(metaPlacement("instagram", "story")).toBe("instagram_stories");
    expect(metaPlacement("instagram", "instagram_reels")).toBe("instagram_reels");
    expect(metaPlacement("messenger", "messenger_inbox")).toBe("messenger");
    expect(metaPlacement("audience_network", "an_classic")).toBe("audience_network");
  });

  it("keeps a placement it has never seen, under its own name", () => {
    expect(placementFor("instagram_threads_feed")).toEqual({
      key: "instagram_threads_feed",
      label: "Instagram threads feed",
      platform: "meta",
    });
  });
});

describe("Google Ads", () => {
  it("is not configured until every variable is set", () => {
    expect(googleAdsConfigured({})).toBe(false);
    expect(googleAdsConfigured({ ...GOOGLE_ENV, GOOGLE_ADS_REFRESH_TOKEN: "" })).toBe(false);
    expect(googleAdsConfigured(GOOGLE_ENV)).toBe(true);
  });

  it("reads totals, networks and cities for one campaign", async () => {
    const calls: Array<{ url: string; init?: RequestInit; query?: string }> = [];
    const fake = async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        calls.push({ url, init });
        return json({ access_token: "access" });
      }
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      calls.push({ url, init, query });
      if (query.includes("FROM geo_target_constant")) {
        return json({
          results: [
            { geoTargetConstant: { resourceName: "geoTargetConstants/1026481", canonicalName: "Riverton,Utah,United States" } },
          ],
        });
      }
      if (query.includes("FROM geographic_view")) {
        return json({
          results: [
            { segments: { date: "2026-10-20", geoTargetCity: "geoTargetConstants/1026481" }, metrics: { impressions: "300", clicks: "9", costMicros: "4500000" } },
            { segments: { date: "2026-10-20" }, metrics: { impressions: "20", clicks: "1", costMicros: "500000" } },
          ],
        });
      }
      if (query.includes("segments.ad_network_type")) {
        return json({
          results: [
            { segments: { date: "2026-10-20", adNetworkType: "SEARCH" }, metrics: { impressions: "250", clicks: "8", costMicros: "4000000", conversions: 1.5 } },
            { segments: { date: "2026-10-20", adNetworkType: "MAPS" }, metrics: { impressions: "70", clicks: "2", costMicros: "1000000" } },
          ],
        });
      }
      return json({
        results: [
          { segments: { date: "2026-10-20" }, metrics: { impressions: "320", clicks: "10", costMicros: "5000000", conversions: 1.5, phoneCalls: "2" } },
        ],
      });
    };

    const rows = await fetchGoogleAdsStats({
      customerId: "444-555-6666",
      campaignId: "987654321",
      from: "2026-10-14",
      to: "2026-10-20",
      env: GOOGLE_ENV,
      fetch: fake,
    });

    const report = calls.filter((c) => c.query);
    expect(report[0]!.url).toBe("https://googleads.googleapis.com/v26/customers/4445556666/googleAds:search");
    const headers = report[0]!.init!.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: "Bearer access",
      "developer-token": "dev-token",
      "login-customer-id": "1112223333",
    });
    expect(report.every((c) => !c.query!.includes("FROM campaign") || c.query!.includes("campaign.id = 987654321"))).toBe(true);
    expect(report.some((c) => c.query!.includes("BETWEEN '2026-10-14' AND '2026-10-20'"))).toBe(true);

    expect(rows).toContainEqual({ day: "2026-10-20", dimension: "total", value: "", impressions: 320, clicks: 10, costMicros: 5000000, calls: 2, leads: 0, conversions: 1.5 });
    expect(rows).toContainEqual(expect.objectContaining({ dimension: "placement", value: "google_maps", impressions: 70 }));
    expect(rows).toContainEqual(expect.objectContaining({ dimension: "location", value: "Riverton, Utah", clicks: 9 }));
    expect(rows).toContainEqual(expect.objectContaining({ dimension: "location", value: "Unknown location", clicks: 1 }));
  });

  it("names a revoked refresh token as the operator's to fix", async () => {
    const fake = async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    await expect(
      fetchGoogleAdsStats({ customerId: "1", campaignId: "2", from: "2026-10-01", to: "2026-10-02", env: GOOGLE_ENV, fetch: fake }),
    ).rejects.toMatchObject({ kind: "auth", message: expect.stringMatching(/revoked/) });
  });

  it("refuses a campaign id that is not digits, so nothing reaches the query", async () => {
    const fake = async () => json({ access_token: "access" });
    await expect(
      fetchGoogleAdsStats({ customerId: "1", campaignId: "1 OR 1=1", from: "2026-10-01", to: "2026-10-02", env: GOOGLE_ENV, fetch: fake }),
    ).rejects.toBeInstanceOf(AdsApiError);
  });

  it("formats a place from its canonical name", () => {
    expect(placeLabel("Riverton,Utah,United States")).toBe("Riverton, Utah");
    expect(placeLabel("Utah,United States")).toBe("Utah, United States");
  });
});

describe("Meta", () => {
  it("is not configured without both the token and the app secret", () => {
    expect(metaConfigured({ META_SYSTEM_USER_TOKEN: "t" })).toBe(false);
    expect(metaConfigured(META_ENV)).toBe(true);
  });

  it("reads totals, placements and regions, signing every call", async () => {
    const urls: URL[] = [];
    const fake = async (url: string) => {
      const parsed = new URL(url);
      urls.push(parsed);
      const breakdowns = parsed.searchParams.get("breakdowns");
      if (breakdowns === "publisher_platform,platform_position") {
        return json({
          data: [
            { date_start: "2026-10-20", impressions: "800", inline_link_clicks: "12", spend: "6.50", publisher_platform: "instagram", platform_position: "instagram_reels" },
            { date_start: "2026-10-20", impressions: "200", inline_link_clicks: "3", spend: "1.50", publisher_platform: "facebook", platform_position: "feed" },
          ],
        });
      }
      if (breakdowns === "region") {
        return json({ data: [{ date_start: "2026-10-20", impressions: "1000", inline_link_clicks: "15", spend: "8.00", region: "Utah" }] });
      }
      return json({
        data: [
          {
            date_start: "2026-10-20",
            impressions: "1000",
            inline_link_clicks: "15",
            spend: "8.00",
            actions: [
              { action_type: "lead", value: "2" },
              { action_type: "onsite_conversion.lead_grouped", value: "2" },
              { action_type: "click_to_call_native_call_placed", value: "1" },
              { action_type: "link_click", value: "15" },
            ],
          },
        ],
        paging: {},
      });
    };

    const rows = await fetchMetaStats({ objectId: "120200000000", from: "2026-10-14", to: "2026-10-20", env: META_ENV, fetch: fake });

    expect(urls[0]!.pathname).toBe("/v25.0/120200000000/insights");
    expect(urls[0]!.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(urls[0]!.searchParams.get("time_range")!)).toEqual({ since: "2026-10-14", until: "2026-10-20" });
    const proof = createHmac("sha256", "app-secret").update("meta-token").digest("hex");
    expect(urls.every((u) => u.searchParams.get("appsecret_proof") === proof)).toBe(true);

    // "lead" and "lead_grouped" are the same two leads, not four.
    expect(rows).toContainEqual({ day: "2026-10-20", dimension: "total", value: "", impressions: 1000, clicks: 15, costMicros: 8000000, calls: 1, leads: 2, conversions: 3 });
    expect(rows).toContainEqual(expect.objectContaining({ dimension: "placement", value: "instagram_reels", costMicros: 6500000 }));
    expect(rows).toContainEqual(expect.objectContaining({ dimension: "location", value: "Utah" }));
  });

  it("follows the next page", async () => {
    let calls = 0;
    const fake = async (url: string) => {
      calls += 1;
      if (url.includes("after=PAGE2")) return json({ data: [{ date_start: "2026-10-19", impressions: "5" }] });
      if (new URL(url).searchParams.get("breakdowns")) return json({ data: [] });
      return json({
        data: [{ date_start: "2026-10-20", impressions: "10" }],
        paging: { next: "https://graph.facebook.com/v25.0/1/insights?after=PAGE2" },
      });
    };
    const rows = await fetchMetaStats({ objectId: "1", from: "2026-10-19", to: "2026-10-20", env: META_ENV, fetch: fake });
    expect(rows.filter((r) => r.dimension === "total").map((r) => r.day).sort()).toEqual(["2026-10-19", "2026-10-20"]);
    expect(calls).toBe(4);
  });

  it("reads an expired token as the operator's to renew", async () => {
    const fake = async () => json({ error: { message: "Error validating access token", code: 190 } }, 400);
    await expect(
      fetchMetaStats({ objectId: "1", from: "2026-10-19", to: "2026-10-20", env: META_ENV, fetch: fake }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("buildReport", () => {
  const stat = (over: Partial<StoredStat>): StoredStat => ({
    day: "2026-10-20",
    dimension: "total",
    dimensionValue: "",
    impressions: 0,
    clicks: 0,
    costMicros: 0,
    calls: 0,
    leads: 0,
    conversions: 0,
    ...over,
  });

  it("totals from total rows, never from a breakdown", () => {
    const report = buildReport(
      [
        stat({ impressions: 1000, clicks: 20, costMicros: 10_000_000, calls: 2 }),
        stat({ dimension: "location", dimensionValue: "Riverton, Utah", impressions: 600, clicks: 12 }),
      ],
      { from: "2026-10-20", through: "2026-10-20" },
    );
    expect(report.totals).toMatchObject({ impressions: 1000, clicks: 20, calls: 2, ctr: 0.02, cpcMicros: 500_000 });
  });

  it("says nothing about a rate it has no figures for", () => {
    const report = buildReport([], { from: "2026-10-18", through: "2026-10-20" });
    expect(report.hasData).toBe(false);
    expect(report.totals.ctr).toBeNull();
    expect(report.totals.cpcMicros).toBeNull();
  });

  it("fills quiet days with zero up to the last day reported, and stops there", () => {
    const report = buildReport(
      [stat({ day: "2026-10-18", clicks: 3 }), stat({ day: "2026-10-20", clicks: 5 })],
      { from: "2026-10-17", through: "2026-10-20" },
    );
    expect(report.daily.map((d) => [d.day, d.clicks])).toEqual([
      ["2026-10-17", 0],
      ["2026-10-18", 3],
      ["2026-10-19", 0],
      ["2026-10-20", 5],
    ]);
  });

  it("adds two channels' days together", () => {
    const report = buildReport(
      [stat({ clicks: 3, costMicros: 1_000_000 }), stat({ clicks: 4, costMicros: 2_000_000 })],
      { from: "2026-10-20", through: "2026-10-20" },
    );
    expect(report.daily).toEqual([{ day: "2026-10-20", impressions: 0, clicks: 7, costMicros: 3_000_000 }]);
  });

  it("ranks placements by impressions and labels them for people", () => {
    const report = buildReport(
      [
        stat({ dimension: "placement", dimensionValue: "google_maps", impressions: 50 }),
        stat({ dimension: "placement", dimensionValue: "instagram_reels", impressions: 400 }),
        stat({ dimension: "placement", dimensionValue: "instagram_reels", day: "2026-10-19", impressions: 100 }),
      ],
      { from: "2026-10-19", through: "2026-10-20" },
    );
    expect(report.placements.map((p) => [p.label, p.impressions, p.platform])).toEqual([
      ["Instagram Reels", 500, "meta"],
      ["Google Maps", 50, "google_ads"],
    ]);
  });

  it("lists the top places and folds the rest into 'Everywhere else'", () => {
    const rows = Array.from({ length: TOP_LOCATIONS + 3 }, (_, i) =>
      stat({ dimension: "location", dimensionValue: `Town ${i}`, impressions: 100 - i }),
    );
    const report = buildReport(rows, { from: "2026-10-20", through: "2026-10-20" });
    expect(report.locations).toHaveLength(TOP_LOCATIONS + 1);
    expect(report.locations.at(-1)).toMatchObject({ label: "Everywhere else", impressions: 92 + 91 + 90 });
  });
});
