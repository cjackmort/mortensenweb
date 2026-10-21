import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  AD_MANAGEMENT_FEE,
  adChannel,
  managementFeeCents,
  type AdChannelKey,
} from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import {
  adCampaignChannels,
  adCampaigns,
  businessProfiles,
  clients,
  mediaAssets,
  organizations,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { businessDate } from "@/lib/billing/period";
import { draftAd } from "@/lib/ads/draft";
import { creativeProblems, type CallToAction, type CreativeInput } from "@/lib/ads/creative";
import { validateBudgets, type ChannelBudget } from "@/lib/ads/money";
import { addDays } from "@/lib/ads/dates";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * A client's ad campaigns, tenant-scoped.
 *
 * Every query filters on `ctx.organizationId`; a public id from another
 * tenant is `NotFoundError`, indistinguishable from one that never existed.
 *
 * The client can change a campaign only while it is a `draft`. Once they have
 * started paying, the money and the creative are fixed until they explicitly
 * take it back to a draft (`ad-checkout.ts`), which cancels the checkout —
 * otherwise what they paid for and what we review could differ.
 */

export type CampaignStatus =
  | "draft"
  | "awaiting_payment"
  | "pending_review"
  | "rejected"
  | "approved"
  | "active"
  | "paused"
  | "ended"
  | "cancelled";

export interface CampaignChannel {
  channel: AdChannelKey;
  budgetCents: number;
  status: string;
  spendMicros: number;
  lastSyncedAt: Date | null;
}

export interface CampaignSummary {
  publicId: string;
  name: string;
  status: CampaignStatus;
  spendBudgetCents: number;
  managementFeeCents: number;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: Date;
  channels: AdChannelKey[];
}

export interface CampaignDetail extends Omit<CampaignSummary, "channels"> {
  headlines: string[];
  descriptions: string[];
  callToAction: CallToAction | null;
  finalUrl: string | null;
  phone: string | null;
  imageAssetPublicId: string | null;
  targetAreas: string[];
  draftFacts: Record<string, string> | null;
  feeBasisPoints: number | null;
  feeMinimumCents: number | null;
  paidAt: Date | null;
  refundedCents: number;
  settledAt: Date | null;
  reviewNote: string | null;
  launchedAt: Date | null;
  endedAt: Date | null;
  channels: CampaignChannel[];
}

export { addDays, durationDays } from "@/lib/ads/dates";

export async function listCampaigns(db: Database, ctx: TenantContext): Promise<CampaignSummary[]> {
  const rows = await db
    .select({
      id: adCampaigns.id,
      publicId: adCampaigns.publicId,
      name: adCampaigns.name,
      status: adCampaigns.status,
      spendBudgetCents: adCampaigns.spendBudgetCents,
      managementFeeCents: adCampaigns.managementFeeCents,
      startsOn: adCampaigns.startsOn,
      endsOn: adCampaigns.endsOn,
      createdAt: adCampaigns.createdAt,
    })
    .from(adCampaigns)
    .where(eq(adCampaigns.organizationId, ctx.organizationId))
    .orderBy(desc(adCampaigns.createdAt), desc(adCampaigns.id))
    .limit(100);

  if (rows.length === 0) return [];

  const channels = await db
    .select({ campaignId: adCampaignChannels.campaignId, channel: adCampaignChannels.channel })
    .from(adCampaignChannels)
    .where(inArray(adCampaignChannels.campaignId, rows.map((r) => r.id)))
    .orderBy(asc(adCampaignChannels.createdAt));

  return rows.map(({ id, ...row }) => ({
    ...row,
    status: row.status as CampaignStatus,
    channels: channels.filter((c) => c.campaignId === id).map((c) => c.channel as AdChannelKey),
  }));
}

/** The campaign row, inside the tenant, or `NotFoundError`. */
async function ownCampaign(db: Database, ctx: TenantContext, publicId: string) {
  const rows = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.publicId, publicId), eq(adCampaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
}

export async function getCampaign(db: Database, ctx: TenantContext, publicId: string): Promise<CampaignDetail> {
  const row = await ownCampaign(db, ctx, publicId);

  const [channels, image] = await Promise.all([
    db
      .select({
        channel: adCampaignChannels.channel,
        budgetCents: adCampaignChannels.budgetCents,
        status: adCampaignChannels.status,
        spendMicros: adCampaignChannels.spendMicros,
        lastSyncedAt: adCampaignChannels.lastSyncedAt,
      })
      .from(adCampaignChannels)
      .where(eq(adCampaignChannels.campaignId, row.id))
      .orderBy(asc(adCampaignChannels.createdAt)),
    row.imageAssetId
      ? db
          .select({ publicId: mediaAssets.publicId })
          .from(mediaAssets)
          .where(and(eq(mediaAssets.id, row.imageAssetId), isNull(mediaAssets.deletedAt)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  return {
    publicId: row.publicId,
    name: row.name,
    status: row.status as CampaignStatus,
    spendBudgetCents: row.spendBudgetCents,
    managementFeeCents: row.managementFeeCents,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    createdAt: row.createdAt,
    headlines: row.headlines,
    descriptions: row.descriptions,
    callToAction: (row.callToAction as CallToAction | null) ?? null,
    finalUrl: row.finalUrl,
    phone: row.phone,
    imageAssetPublicId: image[0]?.publicId ?? null,
    targetAreas: row.targetAreas,
    draftFacts: row.draftFacts ?? null,
    feeBasisPoints: row.feeBasisPoints,
    feeMinimumCents: row.feeMinimumCents,
    paidAt: row.paidAt,
    refundedCents: row.refundedCents,
    settledAt: row.settledAt,
    reviewNote: row.reviewNote,
    launchedAt: row.launchedAt,
    endedAt: row.endedAt,
    channels: channels.map((c) => ({ ...c, channel: c.channel as AdChannelKey })),
  };
}

/** Photos the client could use, newest first. Ready and not in the trash. */
export async function listAdImages(db: Database, ctx: TenantContext, limit = 40) {
  return db
    .select({
      publicId: mediaAssets.publicId,
      title: mediaAssets.title,
      width: mediaAssets.width,
      height: mediaAssets.height,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(desc(mediaAssets.createdAt))
    .limit(limit);
}

/** Where an ad should send people: the live site the portal manages, if any. */
async function liveSiteUrl(db: Database, ctx: TenantContext): Promise<{ id: string; url: string } | null> {
  const rows = await db
    .select({ id: sites.id, productionUrl: sites.productionUrl, primaryDomain: sites.primaryDomain })
    .from(sites)
    .where(and(eq(sites.organizationId, ctx.organizationId), isNull(sites.archivedAt)))
    .orderBy(asc(sites.createdAt))
    .limit(5);

  for (const site of rows) {
    const url = site.primaryDomain ? `https://${site.primaryDomain}` : site.productionUrl;
    if (url) return { id: site.id, url };
  }
  return null;
}

/**
 * "Create ad": a draft written from the business profile and media library.
 *
 * The draft is saved straight away, so the client lands on an editor with
 * something in it rather than a blank form, and a draft they walk away from
 * is still there when they come back.
 */
export async function createDraftCampaign(
  db: Database,
  ctx: TenantContext,
): Promise<{ publicId: string; missing: string[] }> {
  assertMutable(ctx);

  const [org] = await db
    .select({ name: organizations.name, details: businessProfiles.details, clientId: clients.id })
    .from(organizations)
    .innerJoin(clients, eq(clients.organizationId, organizations.id))
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, organizations.id))
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  if (!org) throw new NotFoundError("Your account is not linked to a client record.");

  const [site, images] = await Promise.all([liveSiteUrl(db, ctx), listAdImages(db, ctx, 20)]);

  const draft = draftAd({
    profile: org.details ?? {},
    organizationName: org.name,
    siteUrl: site?.url ?? null,
    images,
  });

  const imageId = draft.imageAssetPublicId
    ? (
        await db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(
            and(
              eq(mediaAssets.publicId, draft.imageAssetPublicId),
              eq(mediaAssets.organizationId, ctx.organizationId),
            ),
          )
          .limit(1)
      )[0]?.id
    : undefined;

  const publicId = newPublicId();
  await db.insert(adCampaigns).values({
    publicId,
    organizationId: ctx.organizationId,
    clientId: org.clientId,
    siteId: site?.id ?? null,
    name: draft.name,
    headlines: draft.headlines,
    descriptions: draft.descriptions,
    callToAction: draft.callToAction,
    finalUrl: draft.finalUrl,
    phone: draft.phone,
    imageAssetId: imageId ?? null,
    targetAreas: draft.targetAreas,
    draftSource: "template",
    draftFacts: draft.facts,
    createdBy: ctx.userId,
  });

  return { publicId, missing: draft.missing };
}

/**
 * Which states let the client change what. The words can change in a draft,
 * and after we send an ad back; the money only in a draft, because once it
 * is paid the budgets are what Stripe charged.
 */
async function requireDraft(db: Database, ctx: TenantContext, publicId: string, { creative = false } = {}) {
  const campaign = await ownCampaign(db, ctx, publicId);
  const editable = campaign.status === "draft" || (creative && campaign.status === "rejected");
  return editable ? { campaign, editable: true as const } : { campaign, editable: false as const };
}

export type SaveOutcome =
  | { ok: true; problems: string[] }
  | { ok: false; reason: "not_editable"; message: string };

const NOT_EDITABLE = {
  ok: false as const,
  reason: "not_editable" as const,
  message: "This ad can't be changed now. Take it back to a draft first.",
};

/**
 * Save what the client wrote, problems and all, and say what the problems
 * are. Refusing to save an over-long headline would lose the rest of their
 * edits; checkout is where problems stop them.
 */
export async function saveCreative(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: CreativeInput,
): Promise<SaveOutcome> {
  assertMutable(ctx);
  const { campaign, editable } = await requireDraft(db, ctx, publicId, { creative: true });
  if (!editable) return NOT_EDITABLE;

  let imageAssetId: string | null = null;
  if (input.imageAssetPublicId) {
    const [image] = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.publicId, input.imageAssetPublicId),
          // The tenant boundary: a photo id from someone else's library is no photo.
          eq(mediaAssets.organizationId, ctx.organizationId),
          eq(mediaAssets.status, "ready"),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .limit(1);
    imageAssetId = image?.id ?? null;
  }

  await db
    .update(adCampaigns)
    .set({
      name: input.name || campaign.name,
      headlines: input.headlines,
      descriptions: input.descriptions,
      callToAction: input.callToAction,
      finalUrl: input.finalUrl,
      phone: input.phone,
      targetAreas: input.targetAreas,
      imageAssetId,
      updatedAt: new Date(),
    })
    .where(eq(adCampaigns.id, campaign.id));

  return { ok: true, problems: creativeProblems(input) };
}

export type ChannelsOutcome =
  | { ok: true }
  | { ok: false; errors: Partial<Record<AdChannelKey | "form" | "startsOn", string>> };

/** How far ahead a client can schedule a start, and how soon. */
const EARLIEST_START_DAYS = 1;
const LATEST_START_DAYS = 60;

/**
 * Where it runs, for how much, and from when.
 *
 * The dates are a request, not a promise: we check every ad before it goes
 * out, and if that takes longer than the start date allows, launch moves both
 * dates together so the client still gets the days they paid for.
 */
export async function saveChannels(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: { channels: ChannelBudget[]; days: number; startsOn: string },
  { now = new Date() }: { now?: Date } = {},
): Promise<ChannelsOutcome> {
  assertMutable(ctx);
  const { campaign, editable } = await requireDraft(db, ctx, publicId);
  if (!editable) return { ok: false, errors: { form: NOT_EDITABLE.message } };

  const checked = validateBudgets(input.channels, input.days);
  const today = businessDate(now);
  const startError =
    !/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn) || input.startsOn < addDays(today, EARLIEST_START_DAYS)
      ? "Choose a start date from tomorrow on."
      : input.startsOn > addDays(today, LATEST_START_DAYS)
        ? `Choose a start date within the next ${LATEST_START_DAYS} days.`
        : null;

  if (!checked.ok || startError) {
    return {
      ok: false,
      errors: { ...(checked.ok ? {} : checked.errors), ...(startError ? { startsOn: startError } : {}) },
    };
  }

  await db.delete(adCampaignChannels).where(eq(adCampaignChannels.campaignId, campaign.id));
  await db.insert(adCampaignChannels).values(
    input.channels.map((c) => ({
      campaignId: campaign.id,
      channel: c.channel,
      platform: adChannel(c.channel).platform,
      budgetCents: c.budgetCents,
    })),
  );

  await db
    .update(adCampaigns)
    .set({
      spendBudgetCents: checked.spendCents,
      // A preview at today's terms. Checkout copies the terms and recomputes,
      // so this is never what is charged.
      managementFeeCents: managementFeeCents(checked.spendCents, AD_MANAGEMENT_FEE),
      startsOn: input.startsOn,
      endsOn: addDays(input.startsOn, input.days - 1),
      updatedAt: new Date(),
    })
    .where(eq(adCampaigns.id, campaign.id));

  return { ok: true };
}

/** A draft nobody has paid for can simply go. */
export async function discardDraft(db: Database, ctx: TenantContext, publicId: string): Promise<boolean> {
  assertMutable(ctx);
  const deleted = await db
    .delete(adCampaigns)
    .where(
      and(
        eq(adCampaigns.publicId, publicId),
        eq(adCampaigns.organizationId, ctx.organizationId),
        eq(adCampaigns.status, "draft"),
        isNull(adCampaigns.paymentRequestId),
      ),
    )
    .returning({ id: adCampaigns.id });
  return deleted.length > 0;
}

/**
 * Back to us after we asked for a change. Only when the ad now keeps the
 * rules: sending back an ad that would be refused again wastes a review.
 */
export async function resubmitCampaign(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertMutable(ctx);
  const campaign = await ownCampaign(db, ctx, publicId);
  if (campaign.status !== "rejected") return { ok: false, message: "This ad isn't waiting on a change from you." };
  if (creativeProblems(campaign).length > 0) return { ok: false, message: "Fix what the checks below point out first." };

  const now = new Date();
  await db
    .update(adCampaigns)
    .set({ status: "pending_review", updatedAt: now })
    .where(and(eq(adCampaigns.id, campaign.id), eq(adCampaigns.status, "rejected")));
  return { ok: true };
}
