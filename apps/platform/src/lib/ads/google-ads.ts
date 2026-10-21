import { googlePlacement } from "./placements";
import { AdsApiError, count, kindForStatus, mergeRows, type AdStatRow, type Env, type FetchLike } from "./stats";

/**
 * Reading a campaign's results from the Google Ads API, over plain REST.
 *
 * Plain `fetch` rather than `google-ads-api` or Google's gRPC client: those
 * pull in protobuf and gRPC runtimes measured in megabytes, for three report
 * queries, into the function #115 just halved.
 *
 * ## Access
 *
 * One agency manager account (MCC) holds every client's ad account. Requests
 * are made as the operator's Google user, by a refresh token, with the
 * manager account's developer token, and `login-customer-id` names the
 * manager so the client accounts under it are reachable. The client's own
 * customer id is what each channel stores as `external_account_id`.
 *
 * Nothing here is used unless every variable below is set; without them the
 * portal runs in manual mode and says results are not connected.
 */

export const GOOGLE_ADS_ENV = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

/** Each major version is supported for about a year; v26 shipped 2026-10-14. */
const DEFAULT_VERSION = "v26";

export function googleAdsConfigured(env: Env = process.env): boolean {
  return GOOGLE_ADS_ENV.every((name) => Boolean(env[name]));
}

/** `123-456-7890` and `1234567890` are the same account. */
export function customerIdDigits(value: string): string {
  return value.replace(/\D/g, "");
}

interface GoogleConfig {
  developerToken: string;
  loginCustomerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  version: string;
}

function config(env: Env): GoogleConfig {
  if (!googleAdsConfigured(env)) {
    throw new AdsApiError("google_ads", "auth", "Google Ads is not connected: its environment variables are not set.");
  }
  return {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    loginCustomerId: customerIdDigits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!),
    clientId: env.GOOGLE_ADS_CLIENT_ID!,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN!,
    version: env.GOOGLE_ADS_API_VERSION || DEFAULT_VERSION,
  };
}

async function failure(response: Response, what: string): Promise<AdsApiError> {
  let message = `${what} failed with HTTP ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; error_description?: string };
    const detail = typeof body.error === "string" ? body.error_description ?? body.error : body.error?.message;
    if (detail) message = `${what}: ${detail}`;
  } catch {
    // Not JSON; the status says enough.
  }
  return new AdsApiError("google_ads", kindForStatus(response.status), message, response.status);
}

async function accessToken(cfg: GoogleConfig, fetcher: FetchLike): Promise<string> {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = await failure(response, "Refreshing the Google Ads token");
    // A revoked or expired refresh token is the operator's to renew.
    throw new AdsApiError("google_ads", "auth", error.message, response.status);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new AdsApiError("google_ads", "auth", "Google returned no access token.");
  return body.access_token;
}

/** One GAQL query, every page of it. */
async function search(
  cfg: GoogleConfig,
  token: string,
  customerId: string,
  query: string,
  fetcher: FetchLike,
): Promise<Array<Record<string, Record<string, unknown>>>> {
  const results: Array<Record<string, Record<string, unknown>>> = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    const response = await fetcher(
      `https://googleads.googleapis.com/${cfg.version}/customers/${customerIdDigits(customerId)}/googleAds:search`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "developer-token": cfg.developerToken,
          "login-customer-id": cfg.loginCustomerId,
          "content-type": "application/json",
        },
        body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw await failure(response, "A Google Ads report");

    const body = (await response.json()) as {
      results?: Array<Record<string, Record<string, unknown>>>;
      nextPageToken?: string;
    };
    results.push(...(body.results ?? []));
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }

  return results;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function campaignFilter(campaignId: string, from: string, to: string): string {
  if (!/^\d+$/.test(campaignId)) {
    throw new AdsApiError("google_ads", "invalid", `"${campaignId}" is not a Google Ads campaign id (digits only).`);
  }
  if (!DAY.test(from) || !DAY.test(to)) throw new AdsApiError("google_ads", "invalid", "Bad date range.");
  return `campaign.id = ${campaignId} AND segments.date BETWEEN '${from}' AND '${to}'`;
}

function metricsOf(result: Record<string, Record<string, unknown>>) {
  const m = result.metrics ?? {};
  return {
    impressions: count(m.impressions),
    clicks: count(m.clicks),
    costMicros: count(m.costMicros),
    calls: count(m.phoneCalls),
    leads: 0,
    conversions: count(m.conversions),
  };
}

/** "Riverton,Utah,United States" → "Riverton, Utah". */
export function placeLabel(canonicalName: string): string {
  const parts = canonicalName.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, Math.min(2, parts.length)).join(", ") || canonicalName;
}

async function placeNames(
  cfg: GoogleConfig,
  token: string,
  customerId: string,
  resourceNames: string[],
  fetcher: FetchLike,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const valid = [...new Set(resourceNames)].filter((r) => /^geoTargetConstants\/\d+$/.test(r));
  for (let i = 0; i < valid.length; i += 200) {
    const batch = valid.slice(i, i + 200);
    const rows = await search(
      cfg,
      token,
      customerId,
      `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${batch.map((r) => `'${r}'`).join(", ")})`,
      fetcher,
    );
    for (const row of rows) {
      const geo = row.geoTargetConstant ?? {};
      if (typeof geo.resourceName === "string" && typeof geo.canonicalName === "string") {
        names.set(geo.resourceName, placeLabel(geo.canonicalName));
      }
    }
  }
  return names;
}

/**
 * A campaign's daily totals, its placements (`segments.ad_network_type`) and
 * where the people who saw it were (`geographic_view`, by city, falling back
 * to the region when Google could not place someone in a city).
 */
export async function fetchGoogleAdsStats(input: {
  customerId: string;
  campaignId: string;
  from: string;
  to: string;
  env?: Env;
  fetch?: FetchLike;
}): Promise<AdStatRow[]> {
  const fetcher = input.fetch ?? fetch;
  const cfg = config(input.env ?? process.env);
  const token = await accessToken(cfg, fetcher);
  const where = campaignFilter(input.campaignId, input.from, input.to);
  const metrics = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions";

  const [totals, networks, places] = await Promise.all([
    search(cfg, token, input.customerId, `SELECT segments.date, ${metrics}, metrics.phone_calls FROM campaign WHERE ${where}`, fetcher),
    search(cfg, token, input.customerId, `SELECT segments.date, segments.ad_network_type, ${metrics} FROM campaign WHERE ${where}`, fetcher),
    search(
      cfg,
      token,
      input.customerId,
      `SELECT segments.date, segments.geo_target_city, segments.geo_target_region, ${metrics} FROM geographic_view WHERE ${where}`,
      fetcher,
    ),
  ]);

  const placeOf = (row: Record<string, Record<string, unknown>>) =>
    (row.segments?.geoTargetCity as string | undefined) || (row.segments?.geoTargetRegion as string | undefined) || "";
  const names = await placeNames(cfg, token, input.customerId, places.map(placeOf), fetcher);

  const day = (row: Record<string, Record<string, unknown>>) => String(row.segments?.date ?? "");

  return mergeRows([
    ...totals.map((row) => ({ day: day(row), dimension: "total" as const, value: "", ...metricsOf(row) })),
    ...networks.map((row) => ({
      day: day(row),
      dimension: "placement" as const,
      value: googlePlacement(row.segments?.adNetworkType as string | undefined),
      ...metricsOf(row),
    })),
    ...places.map((row) => ({
      day: day(row),
      dimension: "location" as const,
      value: names.get(placeOf(row)) ?? "Unknown location",
      ...metricsOf(row),
    })),
  ]).filter((row) => DAY.test(row.day));
}
