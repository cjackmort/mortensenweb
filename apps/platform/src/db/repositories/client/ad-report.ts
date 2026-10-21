import { and, eq } from "drizzle-orm";
import type { AdChannelKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { adCampaignChannels, adCampaigns, adStatsDaily } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { googleAdsConfigured } from "@/lib/ads/google-ads";
import { metaConfigured } from "@/lib/ads/meta";
import { buildReport, type CampaignReport } from "@/lib/ads/report";
import type { Env } from "@/lib/ads/stats";
import { NotFoundError, type TenantContext } from "../context";

/**
 * A campaign's results, for the client's campaign page.
 *
 * The report says *why* it has no figures when it has none, because "no data"
 * and "not connected yet" mean opposite things to someone who has paid:
 *
 *  - `waiting`: launched and linked, and the platform has not reported yet
 *  - `not_connected`: running, but the portal cannot read it yet (manual
 *    launch with no credentials) — the operator's to fix, never shown as zero
 *  - `reporting`: figures exist
 */

export type ReportState = "not_started" | "waiting" | "not_connected" | "reporting";

export interface CampaignResults {
  state: ReportState;
  report: CampaignReport;
  lastSyncedAt: Date | null;
  /** Spent so far, against what was paid for. */
  spentMicros: number;
  budgetCents: number;
  channels: Array<{ channel: AdChannelKey; connected: boolean; lastSyncedAt: Date | null }>;
}

export async function getCampaignResults(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  { now = new Date(), env = process.env }: { now?: Date; env?: Env } = {},
): Promise<CampaignResults> {
  const [campaign] = await db
    .select({
      id: adCampaigns.id,
      launchedAt: adCampaigns.launchedAt,
      startsOn: adCampaigns.startsOn,
      endsOn: adCampaigns.endsOn,
      spendBudgetCents: adCampaigns.spendBudgetCents,
    })
    .from(adCampaigns)
    .where(and(eq(adCampaigns.publicId, publicId), eq(adCampaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!campaign) throw new NotFoundError();

  const [channels, rows] = await Promise.all([
    db
      .select({
        channel: adCampaignChannels.channel,
        platform: adCampaignChannels.platform,
        externalCampaignId: adCampaignChannels.externalCampaignId,
        lastSyncedAt: adCampaignChannels.lastSyncedAt,
        spendMicros: adCampaignChannels.spendMicros,
      })
      .from(adCampaignChannels)
      .where(eq(adCampaignChannels.campaignId, campaign.id)),
    db
      .select({
        day: adStatsDaily.day,
        dimension: adStatsDaily.dimension,
        dimensionValue: adStatsDaily.dimensionValue,
        impressions: adStatsDaily.impressions,
        clicks: adStatsDaily.clicks,
        costMicros: adStatsDaily.costMicros,
        calls: adStatsDaily.calls,
        leads: adStatsDaily.leads,
        conversions: adStatsDaily.conversions,
      })
      .from(adStatsDaily)
      // Both columns, so a campaign id from another tenant can never pull rows.
      .where(and(eq(adStatsDaily.campaignId, campaign.id), eq(adStatsDaily.organizationId, ctx.organizationId))),
  ]);

  const connected = (c: (typeof channels)[number]) =>
    Boolean(c.externalCampaignId) && (c.platform === "google_ads" ? googleAdsConfigured(env) : metaConfigured(env));

  const synced = channels.map((c) => c.lastSyncedAt).filter((d): d is Date => Boolean(d));
  const lastSyncedAt = synced.length ? new Date(Math.max(...synced.map((d) => d.getTime()))) : null;

  // The last day reported on: the day of the latest sync, or the last day of
  // the campaign when that came first.
  const today = businessDate(now);
  const syncedThrough = lastSyncedAt ? businessDate(lastSyncedAt) : null;
  const through = syncedThrough && campaign.endsOn && campaign.endsOn < syncedThrough ? campaign.endsOn : syncedThrough;
  const report = buildReport(rows, { from: campaign.launchedAt ? campaign.startsOn : null, through: through && through <= today ? through : today });

  const state: ReportState = !campaign.launchedAt
    ? "not_started"
    : report.hasData
      ? "reporting"
      : channels.some(connected)
        ? "waiting"
        : "not_connected";

  return {
    state,
    report,
    lastSyncedAt,
    spentMicros: channels.reduce((n, c) => n + c.spendMicros, 0),
    budgetCents: campaign.spendBudgetCents,
    channels: channels.map((c) => ({ channel: c.channel as AdChannelKey, connected: connected(c), lastSyncedAt: c.lastSyncedAt })),
  };
}
