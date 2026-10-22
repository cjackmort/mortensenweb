import { and, eq, inArray } from "drizzle-orm";
import { isAdChannelKey, type AdChannelKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { adCampaignChannels, adCampaigns, auditLog } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { buildAdLiveEmail } from "@/lib/email/ad-updates";
import { customerIdDigits } from "@/lib/ads/google-ads";
import { addDays, campaignDates, durationDays } from "@/lib/ads/dates";
import type { AdminContext } from "../context";
import { campaignUrl, tellClient } from "./ads";

/**
 * Putting an approved campaign on the air, and taking it off.
 *
 * ## Manual mode
 *
 * Until the platform credentials exist, the operator builds each channel's
 * campaign in Google Ads or Meta Ads Manager by hand and pastes its ids here.
 * From then on the portal treats it exactly like one it created: the stats
 * sync reads by those ids as soon as credentials are added, and the client's
 * report fills in.
 *
 * Pausing or ending here records the state for the portal; in manual mode the
 * operator also has to pause it in the platform, and the admin page says so.
 */

export type LaunchOutcome = { ok: true } | { ok: false; message: string };

const LAUNCHABLE = new Set(["approved", "active", "paused"]);

/**
 * The platform's ids for one channel: the account (Google customer id, or
 * Meta `act_…`) and the campaign or ad set. Digits only, as both platforms
 * issue them, because the sync interpolates the campaign id into a query.
 */
export async function recordChannelLaunch(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  input: { channel: string; accountId: string; campaignId: string },
): Promise<LaunchOutcome> {
  if (!isAdChannelKey(input.channel)) return { ok: false, message: "Unknown channel." };

  const [campaign] = await db
    .select({ id: adCampaigns.id, status: adCampaigns.status, organizationId: adCampaigns.organizationId })
    .from(adCampaigns)
    .where(eq(adCampaigns.publicId, publicId))
    .limit(1);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  if (!LAUNCHABLE.has(campaign.status)) return { ok: false, message: "Approve the ad before launching it." };

  const [row] = await db
    .select({ platform: adCampaignChannels.platform })
    .from(adCampaignChannels)
    .where(and(eq(adCampaignChannels.campaignId, campaign.id), eq(adCampaignChannels.channel, input.channel)))
    .limit(1);
  if (!row) return { ok: false, message: "This campaign doesn't run on that channel." };

  const externalCampaignId = input.campaignId.trim();
  if (!/^\d{3,25}$/.test(externalCampaignId)) {
    return { ok: false, message: "Paste the campaign (or ad set) id: digits only, as the platform shows it." };
  }

  const rawAccount = input.accountId.trim();
  const externalAccountId =
    row.platform === "google_ads"
      ? customerIdDigits(rawAccount)
      : rawAccount.startsWith("act_")
        ? rawAccount
        : `act_${rawAccount.replace(/\D/g, "")}`;
  if (!/^(act_)?\d{5,20}$/.test(externalAccountId)) {
    return {
      ok: false,
      message: row.platform === "google_ads" ? "Paste the client's Google Ads customer id (10 digits)." : "Paste the ad account id (act_…).",
    };
  }

  await db
    .update(adCampaignChannels)
    .set({ launchMode: "manual", externalAccountId, externalCampaignId, status: "active", syncError: null, updatedAt: new Date() })
    .where(and(eq(adCampaignChannels.campaignId, campaign.id), eq(adCampaignChannels.channel, input.channel as AdChannelKey)));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: campaign.organizationId,
    action: "ads.channel_linked",
    entityType: "ad_campaign",
    entityId: publicId,
    metadata: { channel: input.channel, externalAccountId, externalCampaignId, mode: "manual" },
  });

  return { ok: true };
}

/**
 * Every channel has its ids: the campaign is live.
 *
 * When it starts later than the client's chosen start, both dates move
 * together, so the client still gets every day they paid for — the promise
 * made on the checkout page.
 */
export async function markCampaignLive(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<LaunchOutcome> {
  const [campaign] = await db.select().from(adCampaigns).where(eq(adCampaigns.publicId, publicId)).limit(1);
  if (!campaign) return { ok: false, message: "Campaign not found." };
  if (campaign.status !== "approved") return { ok: false, message: "Only an approved campaign can go live." };

  const channels = await db
    .select({ channel: adCampaignChannels.channel, externalCampaignId: adCampaignChannels.externalCampaignId })
    .from(adCampaignChannels)
    .where(eq(adCampaignChannels.campaignId, campaign.id));
  const missing = channels.filter((c) => !c.externalCampaignId).map((c) => c.channel);
  if (missing.length > 0) {
    return { ok: false, message: `Add the platform ids for: ${missing.join(", ")}.` };
  }

  const today = businessDate(now);
  const days = durationDays(campaign.startsOn, campaign.endsOn) ?? 30;
  const startsOn = campaign.startsOn && campaign.startsOn > today ? campaign.startsOn : today;
  const endsOn = addDays(startsOn, days - 1);

  const [moved] = await db
    .update(adCampaigns)
    .set({ status: "active", launchedAt: now, startsOn, endsOn, updatedAt: now })
    .where(and(eq(adCampaigns.id, campaign.id), eq(adCampaigns.status, "approved")))
    .returning({ id: adCampaigns.id });
  if (!moved) return { ok: false, message: "Only an approved campaign can go live." };

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: campaign.organizationId,
    action: "ads.campaign_launched",
    entityType: "ad_campaign",
    entityId: publicId,
    metadata: { startsOn, endsOn, movedFrom: campaign.startsOn !== startsOn ? campaign.startsOn : undefined },
  });

  await tellClient(db, campaign.organizationId, (contactName) =>
    buildAdLiveEmail({
      contactName,
      campaignName: campaign.name,
      campaignUrl: campaignUrl(publicId),
      dates: campaignDates({ startsOn, endsOn }),
    }),
  );

  return { ok: true };
}

const TRANSITIONS: Record<"pause" | "resume" | "end" | "cancel", { from: string[]; to: string; action: string }> = {
  pause: { from: ["active"], to: "paused", action: "ads.campaign_paused" },
  resume: { from: ["paused"], to: "active", action: "ads.campaign_resumed" },
  end: { from: ["active", "paused"], to: "ended", action: "ads.campaign_ended" },
  // Before it ran: a rejection the client won't fix, or one we can't run.
  cancel: { from: ["pending_review", "approved", "rejected"], to: "cancelled", action: "ads.campaign_cancelled" },
};

export async function changeCampaignState(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  change: keyof typeof TRANSITIONS,
  { now = new Date(), note }: { now?: Date; note?: string } = {},
): Promise<LaunchOutcome> {
  const rule = TRANSITIONS[change];
  const [moved] = await db
    .update(adCampaigns)
    .set({
      status: rule.to,
      updatedAt: now,
      ...(change === "pause" ? { pausedAt: now } : {}),
      ...(change === "resume" ? { pausedAt: null } : {}),
      ...(change === "end" || change === "cancel" ? { endedAt: now } : {}),
    })
    .where(and(eq(adCampaigns.publicId, publicId), inArray(adCampaigns.status, rule.from)))
    .returning({ id: adCampaigns.id, organizationId: adCampaigns.organizationId });

  if (!moved) return { ok: false, message: `This campaign can't be ${change === "end" ? "ended" : `${change}d`} from where it is.` };

  const channelStatus = change === "pause" ? "paused" : change === "resume" ? "active" : "ended";
  await db
    .update(adCampaignChannels)
    .set({ status: channelStatus, updatedAt: now })
    .where(and(eq(adCampaignChannels.campaignId, moved.id), inArray(adCampaignChannels.status, ["active", "paused", "pending"])));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: moved.organizationId,
    action: rule.action,
    entityType: "ad_campaign",
    entityId: publicId,
    metadata: note ? { note } : {},
  });

  return { ok: true };
}
