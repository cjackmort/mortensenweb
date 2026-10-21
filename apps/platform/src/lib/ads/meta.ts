import { createHmac } from "node:crypto";
import { metaPlacement } from "./placements";
import { AdsApiError, count, kindForStatus, mergeRows, type AdStatRow, type Env, type FetchLike } from "./stats";

/**
 * Reading a Facebook or Instagram channel's results from the Meta Marketing
 * API (Insights), over plain REST, for the same reason as `google-ads.ts`:
 * `facebook-nodejs-business-sdk` is a large download for three GET requests.
 *
 * ## Access
 *
 * The agency's Business Manager holds every client's ad account (or has been
 * given access to it), and a system user's token reads them. `META_APP_SECRET`
 * signs each call (`appsecret_proof`), which Meta requires once the app has
 * "Require app secret" switched on — and which stops a leaked token being
 * usable from anywhere else.
 *
 * A channel's `external_campaign_id` may be the campaign or the ad set: Insights
 * answers for either, and running Facebook and Instagram as two ad sets of one
 * campaign is the usual way to give each its own budget.
 */

export const META_ENV = ["META_SYSTEM_USER_TOKEN", "META_APP_SECRET"] as const;

/** v25.0 shipped 2026-02-18; Meta supports each version for about two years. */
const DEFAULT_VERSION = "v25.0";

export function metaConfigured(env: Env = process.env): boolean {
  return META_ENV.every((name) => Boolean(env[name]));
}

interface MetaRow {
  date_start?: string;
  impressions?: string;
  inline_link_clicks?: string;
  spend?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  publisher_platform?: string;
  platform_position?: string;
  region?: string;
}

const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
const CALL_ACTIONS = ["click_to_call_native_call_placed", "click_to_call_call_confirm"];

/**
 * Meta reports overlapping action types for one event ("lead" is the rollup
 * of the lead types), so the largest is taken rather than the sum — adding
 * them would count one lead two or three times.
 */
function largest(actions: MetaRow["actions"], types: string[]): number {
  return Math.max(0, ...(actions ?? []).filter((a) => types.includes(a.action_type ?? "")).map((a) => count(a.value)));
}

function metricsOf(row: MetaRow) {
  const leads = largest(row.actions, LEAD_ACTIONS);
  const calls = largest(row.actions, CALL_ACTIONS);
  return {
    impressions: count(row.impressions),
    // Link clicks, not all clicks: a tap on "See more" or a like is a click to
    // Meta and not a visit, and counting it would flatter every rate.
    clicks: count(row.inline_link_clicks),
    // Spend arrives as a decimal in the ad account's currency (USD here).
    costMicros: Math.round(count(row.spend) * 1_000_000),
    calls,
    leads,
    // Meta has no single "conversions" figure for a local campaign; the
    // things the report counts as one are a lead or a call.
    conversions: leads + calls,
  };
}

async function insights(
  objectId: string,
  params: Record<string, string>,
  env: Env,
  fetcher: FetchLike,
): Promise<MetaRow[]> {
  const token = env.META_SYSTEM_USER_TOKEN!;
  const version = env.META_GRAPH_API_VERSION || DEFAULT_VERSION;
  const proof = createHmac("sha256", env.META_APP_SECRET!).update(token).digest("hex");

  let url: string | null =
    `https://graph.facebook.com/${version}/${encodeURIComponent(objectId)}/insights?` +
    new URLSearchParams({ ...params, access_token: token, appsecret_proof: proof, limit: "500" }).toString();

  const rows: MetaRow[] = [];
  for (let page = 0; url && page < 20; page += 1) {
    const response: Response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.json().catch(() => ({}))) as {
      data?: MetaRow[];
      paging?: { next?: string };
      error?: { message?: string; code?: number };
    };
    if (!response.ok || body.error) {
      // Code 190 is an invalid or expired token, whatever the HTTP status says.
      const kind = body.error?.code === 190 ? "auth" : kindForStatus(response.status);
      throw new AdsApiError("meta", kind, `Meta Insights: ${body.error?.message ?? `HTTP ${response.status}`}`, response.status);
    }
    rows.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  return rows;
}

/** Daily totals, placements and regions for one campaign or ad set. */
export async function fetchMetaStats(input: {
  objectId: string;
  from: string;
  to: string;
  env?: Env;
  fetch?: FetchLike;
}): Promise<AdStatRow[]> {
  const env = input.env ?? process.env;
  if (!metaConfigured(env)) {
    throw new AdsApiError("meta", "auth", "Meta is not connected: its environment variables are not set.");
  }
  if (!/^\d+$/.test(input.objectId)) {
    throw new AdsApiError("meta", "invalid", `"${input.objectId}" is not a Meta campaign or ad set id (digits only).`);
  }

  const fetcher = input.fetch ?? fetch;
  const base = {
    fields: "impressions,inline_link_clicks,spend,actions",
    time_increment: "1",
    time_range: JSON.stringify({ since: input.from, until: input.to }),
  };

  const [totals, placements, regions] = await Promise.all([
    insights(input.objectId, base, env, fetcher),
    insights(input.objectId, { ...base, breakdowns: "publisher_platform,platform_position" }, env, fetcher),
    insights(input.objectId, { ...base, breakdowns: "region" }, env, fetcher),
  ]);

  const day = (row: MetaRow) => row.date_start ?? "";

  return mergeRows([
    ...totals.map((row) => ({ day: day(row), dimension: "total" as const, value: "", ...metricsOf(row) })),
    ...placements.map((row) => ({
      day: day(row),
      dimension: "placement" as const,
      value: metaPlacement(row.publisher_platform, row.platform_position),
      ...metricsOf(row),
    })),
    ...regions.map((row) => ({
      day: day(row),
      dimension: "location" as const,
      value: row.region?.trim() || "Unknown location",
      ...metricsOf(row),
    })),
  ]).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day));
}
