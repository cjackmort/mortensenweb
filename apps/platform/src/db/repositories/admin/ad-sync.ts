import { and, eq, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { adCampaignChannels, adCampaigns, adStatsDaily, auditLog } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { addDays } from "@/lib/ads/dates";
import { fetchGoogleAdsStats, googleAdsConfigured } from "@/lib/ads/google-ads";
import { fetchMetaStats, metaConfigured } from "@/lib/ads/meta";
import { AdsApiError, type AdStatRow, type Env } from "@/lib/ads/stats";

/**
 * Reading results back from Google Ads and Meta, on the scheduler.
 *
 * Runs from `/api/cron`, self-gated to every six hours like the lead import:
 * nobody is waiting on it to the minute, both platforms only settle a day's
 * figures over the following hours, and each run is several API calls per
 * channel. The admin page has "Sync now" for the operator who just launched.
 *
 * ## What is re-read
 *
 * The first sync reads from the campaign's first day. Later ones re-read the
 * last week, because both platforms revise recent days as late conversions
 * are attributed, and replace those days whole: a placement that drops out of
 * a revised day must drop out here too, which an upsert alone would miss.
 *
 * A campaign that ended keeps syncing for a week for the same reason, so the
 * figure its refund is settled on is the platforms' settled one.
 */

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REVISION_DAYS = 7;
const AFTER_END_DAYS = 7;

export interface SyncFetchers {
  google: typeof fetchGoogleAdsStats;
  meta: typeof fetchMetaStats;
}

const LIVE_FETCHERS: SyncFetchers = { google: fetchGoogleAdsStats, meta: fetchMetaStats };

interface SyncableChannel {
  id: string;
  campaignId: string;
  organizationId: string;
  platform: string;
  externalAccountId: string | null;
  externalCampaignId: string | null;
  lastSyncedAt: Date | null;
  startsOn: string | null;
  endsOn: string | null;
}

export type ChannelSync =
  | { ok: true; rows: number }
  | { ok: false; reason: "not_configured" | "not_linked" | "failed"; message: string };

function platformConfigured(platform: string, env: Env): boolean {
  return platform === "google_ads" ? googleAdsConfigured(env) : metaConfigured(env);
}

export async function syncChannel(
  db: Database,
  channel: SyncableChannel,
  { now = new Date(), env = process.env, fetchers = LIVE_FETCHERS }: { now?: Date; env?: Env; fetchers?: SyncFetchers } = {},
): Promise<ChannelSync> {
  if (!channel.externalCampaignId || !channel.startsOn) {
    return { ok: false, reason: "not_linked", message: "No platform campaign id yet." };
  }
  if (!platformConfigured(channel.platform, env)) {
    return { ok: false, reason: "not_configured", message: "This platform is not connected." };
  }

  const today = businessDate(now);
  const to = channel.endsOn && channel.endsOn < today ? channel.endsOn : today;
  const from = channel.lastSyncedAt
    ? [channel.startsOn, addDays(to, -REVISION_DAYS)].sort().at(-1)!
    : channel.startsOn;
  if (from > to) return { ok: true, rows: 0 };

  let rows: AdStatRow[];
  try {
    rows =
      channel.platform === "google_ads"
        ? await fetchers.google({
            customerId: channel.externalAccountId ?? "",
            campaignId: channel.externalCampaignId,
            from,
            to,
            env,
          })
        : await fetchers.meta({ objectId: channel.externalCampaignId, from, to, env });
  } catch (error) {
    const message = error instanceof AdsApiError || error instanceof Error ? error.message : "Unknown error";
    await db
      .update(adCampaignChannels)
      .set({ syncError: message.slice(0, 500), updatedAt: now })
      .where(eq(adCampaignChannels.id, channel.id));
    return { ok: false, reason: "failed", message };
  }

  // Replace the window whole, so a revised day loses rows as well as gains them.
  await db
    .delete(adStatsDaily)
    .where(and(eq(adStatsDaily.channelId, channel.id), gte(adStatsDaily.day, from), lte(adStatsDaily.day, to)));

  const inWindow = rows.filter((r) => r.day >= from && r.day <= to);
  for (let i = 0; i < inWindow.length; i += 200) {
    await db.insert(adStatsDaily).values(
      inWindow.slice(i, i + 200).map((r) => ({
        organizationId: channel.organizationId,
        campaignId: channel.campaignId,
        channelId: channel.id,
        day: r.day,
        dimension: r.dimension,
        dimensionValue: r.value,
        impressions: r.impressions,
        clicks: r.clicks,
        costMicros: r.costMicros,
        calls: r.calls,
        leads: r.leads,
        conversions: r.conversions,
        syncedAt: now,
      })),
    );
  }

  const [spent] = await db
    .select({ micros: sql<string>`coalesce(sum(${adStatsDaily.costMicros}), 0)` })
    .from(adStatsDaily)
    .where(and(eq(adStatsDaily.channelId, channel.id), eq(adStatsDaily.dimension, "total")));

  await db
    .update(adCampaignChannels)
    .set({ spendMicros: Number(spent?.micros ?? 0), lastSyncedAt: now, syncError: null, updatedAt: now })
    .where(eq(adCampaignChannels.id, channel.id));

  return { ok: true, rows: inWindow.length };
}

async function syncableChannels(db: Database, where: ReturnType<typeof and>): Promise<SyncableChannel[]> {
  return db
    .select({
      id: adCampaignChannels.id,
      campaignId: adCampaignChannels.campaignId,
      organizationId: adCampaigns.organizationId,
      platform: adCampaignChannels.platform,
      externalAccountId: adCampaignChannels.externalAccountId,
      externalCampaignId: adCampaignChannels.externalCampaignId,
      lastSyncedAt: adCampaignChannels.lastSyncedAt,
      startsOn: adCampaigns.startsOn,
      endsOn: adCampaigns.endsOn,
    })
    .from(adCampaignChannels)
    .innerJoin(adCampaigns, eq(adCampaigns.id, adCampaignChannels.campaignId))
    .where(where);
}

/** A running campaign past its last day is over, whether or not anyone pressed End. */
export async function endFinishedCampaigns(db: Database, { now = new Date() }: { now?: Date } = {}): Promise<number> {
  const today = businessDate(now);
  const ended = await db
    .update(adCampaigns)
    .set({ status: "ended", endedAt: now, updatedAt: now })
    .where(and(inArray(adCampaigns.status, ["active", "paused"]), lt(adCampaigns.endsOn, today)))
    .returning({ id: adCampaigns.id, publicId: adCampaigns.publicId, organizationId: adCampaigns.organizationId });

  if (ended.length === 0) return 0;

  await db
    .update(adCampaignChannels)
    .set({ status: "ended", updatedAt: now })
    .where(inArray(adCampaignChannels.campaignId, ended.map((c) => c.id)));
  await db.insert(auditLog).values(
    ended.map((c) => ({
      organizationId: c.organizationId,
      action: "ads.campaign_ended",
      entityType: "ad_campaign",
      entityId: c.publicId,
      metadata: { reason: "end_date_passed" },
    })),
  );
  return ended.length;
}

export type ScheduledAdSync =
  | { ran: false; ended: number; reason: "not_configured" | "too_soon" | "nothing_linked" }
  | { ran: true; ended: number; channels: number; synced: number; failed: number };

export async function runScheduledAdSync(
  db: Database,
  { now = new Date(), env = process.env, fetchers = LIVE_FETCHERS }: { now?: Date; env?: Env; fetchers?: SyncFetchers } = {},
): Promise<ScheduledAdSync> {
  // Cheap and credential-free, so it runs on every pass.
  const ended = await endFinishedCampaigns(db, { now });

  const platforms = [googleAdsConfigured(env) && "google_ads", metaConfigured(env) && "meta"].filter(
    (p): p is string => Boolean(p),
  );
  if (platforms.length === 0) return { ran: false, ended, reason: "not_configured" };

  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, "ads.synced"), gte(auditLog.createdAt, new Date(now.getTime() - SYNC_INTERVAL_MS))))
    .limit(1);
  if (recent.length > 0) return { ran: false, ended, reason: "too_soon" };

  const endedSince = new Date(now.getTime() - AFTER_END_DAYS * 86_400_000);
  const channels = await syncableChannels(
    db,
    and(
      isNotNull(adCampaignChannels.externalCampaignId),
      inArray(adCampaignChannels.platform, platforms),
      or(
        inArray(adCampaigns.status, ["active", "paused"]),
        and(eq(adCampaigns.status, "ended"), gte(adCampaigns.endedAt, endedSince)),
      ),
    ),
  );
  if (channels.length === 0) return { ran: false, ended, reason: "nothing_linked" };

  let synced = 0;
  let failed = 0;
  for (const channel of channels) {
    const outcome = await syncChannel(db, channel, { now, env, fetchers });
    if (outcome.ok) synced += 1;
    else failed += 1;
  }

  await db.insert(auditLog).values({
    action: "ads.synced",
    entityType: "ad_campaign_channels",
    entityId: null,
    metadata: { channels: channels.length, synced, failed },
  });

  return { ran: true, ended, channels: channels.length, synced, failed };
}

/** "Sync now" on one campaign, for the operator; not gated. */
export async function syncCampaignNow(
  db: Database,
  campaignPublicId: string,
  options: { now?: Date; env?: Env; fetchers?: SyncFetchers } = {},
): Promise<ChannelSync[]> {
  const channels = await syncableChannels(
    db,
    and(eq(adCampaigns.publicId, campaignPublicId), isNotNull(adCampaignChannels.externalCampaignId)),
  );
  const results: ChannelSync[] = [];
  for (const channel of channels) results.push(await syncChannel(db, channel, options));
  return results;
}
