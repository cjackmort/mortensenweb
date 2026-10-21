import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AdChannelKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import {
  adCampaignChannels,
  adCampaigns,
  auditLog,
  businessProfiles,
  clients,
  mediaAssets,
  organizationMemberships,
  organizations,
  paymentRequests,
  payments,
  users,
} from "@/db/schema";
import { creativeProblems, unsupportedClaims, type CallToAction } from "@/lib/ads/creative";
import { byChannelOrder, microsToCents, settleCampaign } from "@/lib/ads/money";
import { sendEmail, type EmailMessage } from "@/lib/email/mailer";
import { buildAdNeedsChangesEmail } from "@/lib/email/ad-updates";
import type { CampaignStatus } from "../client/ads";
import { NotFoundError, type AdminContext } from "../context";

/**
 * The operator's side of paid ads.
 *
 * Unscoped by tenant, so it lives with the admin repositories and is reached
 * only through an `AdminContext` — or, for `markAdCampaignPaid`, from inside
 * `confirmPaymentReceived`, which already holds one.
 */

/**
 * Money for a campaign has arrived: it moves to the operator's review queue.
 *
 * Called from `confirmPaymentReceived`, the one place a payment request is
 * ever marked paid, so a campaign settled by the Stripe webhook and one an
 * operator confirmed by hand both arrive here. Conditional on the campaign
 * still waiting for that payment: one the client took back to a draft has a
 * cancelled request, which `confirmPaymentReceived` refuses before this runs.
 */
export async function markAdCampaignPaid(
  db: Database,
  paymentRequestId: string,
  { at = new Date(), actorUserId }: { at?: Date; actorUserId?: string } = {},
): Promise<{ publicId: string } | null> {
  const [moved] = await db
    .update(adCampaigns)
    .set({ status: "pending_review", paidAt: at, updatedAt: at })
    .where(and(eq(adCampaigns.paymentRequestId, paymentRequestId), eq(adCampaigns.status, "awaiting_payment")))
    .returning({ publicId: adCampaigns.publicId, organizationId: adCampaigns.organizationId });

  if (!moved) return null;

  await db.insert(auditLog).values({
    actorUserId: actorUserId ?? null,
    organizationId: moved.organizationId,
    action: "ads.campaign_paid",
    entityType: "ad_campaign",
    entityId: moved.publicId,
    metadata: {},
  });

  return { publicId: moved.publicId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AdminChannel {
  channel: AdChannelKey;
  platform: "google_ads" | "meta";
  budgetCents: number;
  status: string;
  launchMode: string | null;
  externalAccountId: string | null;
  externalCampaignId: string | null;
  spendMicros: number;
  lastSyncedAt: Date | null;
  syncError: string | null;
}

export interface AdminCampaignRow {
  publicId: string;
  name: string;
  status: CampaignStatus;
  clientName: string;
  clientPublicId: string;
  spendBudgetCents: number;
  managementFeeCents: number;
  feeBasisPoints: number | null;
  feeMinimumCents: number | null;
  refundedCents: number;
  paidAt: Date | null;
  launchedAt: Date | null;
  endedAt: Date | null;
  settledAt: Date | null;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: Date;
  channels: AdminChannel[];
}

/** The states an operator acts on. Drafts and unpaid checkouts are the client's. */
const OPERATOR_STATUSES: CampaignStatus[] = [
  "pending_review",
  "rejected",
  "approved",
  "active",
  "paused",
  "ended",
  "cancelled",
];

async function channelsFor(db: Database, campaignIds: string[]) {
  if (campaignIds.length === 0) return [];
  return db
    .select({
      campaignId: adCampaignChannels.campaignId,
      channel: adCampaignChannels.channel,
      platform: adCampaignChannels.platform,
      budgetCents: adCampaignChannels.budgetCents,
      status: adCampaignChannels.status,
      launchMode: adCampaignChannels.launchMode,
      externalAccountId: adCampaignChannels.externalAccountId,
      externalCampaignId: adCampaignChannels.externalCampaignId,
      spendMicros: adCampaignChannels.spendMicros,
      lastSyncedAt: adCampaignChannels.lastSyncedAt,
      syncError: adCampaignChannels.syncError,
    })
    .from(adCampaignChannels)
    .where(inArray(adCampaignChannels.campaignId, campaignIds))
    .orderBy(asc(adCampaignChannels.createdAt));
}

export async function listAdminCampaigns(
  _ctx: AdminContext,
  db: Database,
  { statuses = OPERATOR_STATUSES }: { statuses?: CampaignStatus[] } = {},
): Promise<AdminCampaignRow[]> {
  const rows = await db
    .select({
      id: adCampaigns.id,
      publicId: adCampaigns.publicId,
      name: adCampaigns.name,
      status: adCampaigns.status,
      clientName: organizations.name,
      clientPublicId: clients.publicId,
      spendBudgetCents: adCampaigns.spendBudgetCents,
      managementFeeCents: adCampaigns.managementFeeCents,
      feeBasisPoints: adCampaigns.feeBasisPoints,
      feeMinimumCents: adCampaigns.feeMinimumCents,
      refundedCents: adCampaigns.refundedCents,
      paidAt: adCampaigns.paidAt,
      launchedAt: adCampaigns.launchedAt,
      endedAt: adCampaigns.endedAt,
      settledAt: adCampaigns.settledAt,
      startsOn: adCampaigns.startsOn,
      endsOn: adCampaigns.endsOn,
      createdAt: adCampaigns.createdAt,
    })
    .from(adCampaigns)
    .innerJoin(clients, eq(clients.id, adCampaigns.clientId))
    .innerJoin(organizations, eq(organizations.id, adCampaigns.organizationId))
    .where(inArray(adCampaigns.status, statuses))
    .orderBy(desc(adCampaigns.paidAt), desc(adCampaigns.createdAt))
    .limit(300);

  const channels = await channelsFor(db, rows.map((r) => r.id));

  return rows.map(({ id, ...row }) => ({
    ...row,
    status: row.status as CampaignStatus,
    channels: byChannelOrder(channels.filter((c) => c.campaignId === id)).map(({ campaignId: _campaignId, ...c }) => ({
        ...c,
        channel: c.channel as AdChannelKey,
        platform: c.platform as AdminChannel["platform"],
      })),
  }));
}

export interface AdminCampaignDetail extends AdminCampaignRow {
  id: string;
  organizationId: string;
  headlines: string[];
  descriptions: string[];
  callToAction: CallToAction | null;
  finalUrl: string | null;
  phone: string | null;
  targetAreas: string[];
  imageAssetPublicId: string | null;
  draftFacts: Record<string, string>;
  profile: Record<string, string>;
  reviewNote: string | null;
  reviewedAt: Date | null;
  refundReference: string | null;
  /** What would stop the ad being accepted, and claims the profile does not make. */
  policy: { problems: string[]; claims: string[] };
  payment: {
    reference: string;
    status: string;
    method: string | null;
    provider: string | null;
    providerReference: string | null;
    paymentId: string | null;
  } | null;
}

async function campaignRow(db: Database, publicId: string) {
  const [row] = await db
    .select({
      campaign: adCampaigns,
      clientName: organizations.name,
      clientPublicId: clients.publicId,
      profile: businessProfiles.details,
    })
    .from(adCampaigns)
    .innerJoin(clients, eq(clients.id, adCampaigns.clientId))
    .innerJoin(organizations, eq(organizations.id, adCampaigns.organizationId))
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, adCampaigns.organizationId))
    .where(eq(adCampaigns.publicId, publicId))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

export async function getAdminCampaign(_ctx: AdminContext, db: Database, publicId: string): Promise<AdminCampaignDetail> {
  const { campaign: c, clientName, clientPublicId, profile } = await campaignRow(db, publicId);

  const [channels, image, payment] = await Promise.all([
    channelsFor(db, [c.id]),
    c.imageAssetId
      ? db.select({ publicId: mediaAssets.publicId }).from(mediaAssets).where(eq(mediaAssets.id, c.imageAssetId)).limit(1)
      : Promise.resolve([]),
    c.paymentRequestId
      ? db
          .select({
            reference: paymentRequests.reference,
            status: paymentRequests.status,
            paymentId: paymentRequests.paymentId,
            method: payments.method,
            provider: payments.provider,
            providerReference: payments.providerReference,
          })
          .from(paymentRequests)
          .leftJoin(payments, eq(payments.id, paymentRequests.paymentId))
          .where(eq(paymentRequests.id, c.paymentRequestId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const facts = { ...(profile ?? {}), ...(c.draftFacts ?? {}) };
  const text = [...c.headlines, ...c.descriptions].join(" ");

  return {
    id: c.id,
    organizationId: c.organizationId,
    publicId: c.publicId,
    name: c.name,
    status: c.status as CampaignStatus,
    clientName,
    clientPublicId,
    spendBudgetCents: c.spendBudgetCents,
    managementFeeCents: c.managementFeeCents,
    feeBasisPoints: c.feeBasisPoints,
    feeMinimumCents: c.feeMinimumCents,
    refundedCents: c.refundedCents,
    refundReference: c.refundReference,
    paidAt: c.paidAt,
    launchedAt: c.launchedAt,
    endedAt: c.endedAt,
    settledAt: c.settledAt,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    createdAt: c.createdAt,
    headlines: c.headlines,
    descriptions: c.descriptions,
    callToAction: (c.callToAction as CallToAction | null) ?? null,
    finalUrl: c.finalUrl,
    phone: c.phone,
    targetAreas: c.targetAreas,
    imageAssetPublicId: image[0]?.publicId ?? null,
    draftFacts: c.draftFacts ?? {},
    profile: profile ?? {},
    reviewNote: c.reviewNote,
    reviewedAt: c.reviewedAt,
    policy: { problems: creativeProblems(c), claims: unsupportedClaims(text, facts) },
    payment: payment[0] ?? null,
    channels: byChannelOrder(channels).map(({ campaignId: _campaignId, ...ch }) => ({
      ...ch,
      channel: ch.channel as AdChannelKey,
      platform: ch.platform as AdminChannel["platform"],
    })),
  };
}

export interface AdsOverview {
  /** Ad spend clients have paid for, across every campaign that was paid. */
  paidSpendCents: number;
  /** What the platforms report as spent so far. */
  spentCents: number;
  /** Fees on campaigns that ran: as settled, or as charged while still running. */
  feeRevenueCents: number;
  refundedCents: number;
  activeCampaigns: number;
  needsReview: number;
  readyToLaunch: number;
  refundsDue: number;
}

/** Fee kept on a campaign: nothing if it never ran, the settled figure once it has. */
export function feeKeptCents(row: Pick<AdminCampaignRow, "launchedAt" | "managementFeeCents" | "spendBudgetCents" | "feeBasisPoints" | "feeMinimumCents" | "channels" | "status">): number {
  if (!row.launchedAt) return 0;
  if (row.status !== "ended") return row.managementFeeCents;
  return settleCampaign({
    spendCents: row.spendBudgetCents,
    feeCents: row.managementFeeCents,
    terms: { basisPoints: row.feeBasisPoints ?? 1500, minimumCents: row.feeMinimumCents ?? 2500 },
    actualSpendCents: microsToCents(row.channels.reduce((n, c) => n + c.spendMicros, 0)),
    launched: true,
  }).keptFeeCents;
}

export function adsOverview(rows: AdminCampaignRow[]): AdsOverview {
  const paid = rows.filter((r) => r.paidAt);
  return {
    paidSpendCents: paid.reduce((n, r) => n + r.spendBudgetCents, 0),
    spentCents: microsToCents(paid.reduce((n, r) => n + r.channels.reduce((m, c) => m + c.spendMicros, 0), 0)),
    feeRevenueCents: paid.reduce((n, r) => n + feeKeptCents(r), 0),
    refundedCents: paid.reduce((n, r) => n + r.refundedCents, 0),
    activeCampaigns: rows.filter((r) => r.status === "active").length,
    needsReview: rows.filter((r) => r.status === "pending_review").length,
    readyToLaunch: rows.filter((r) => r.status === "approved").length,
    refundsDue: rows.filter((r) => (r.status === "ended" || r.status === "cancelled") && r.paidAt && !r.settledAt).length,
  };
}

// ---------------------------------------------------------------------------
// Telling the client
// ---------------------------------------------------------------------------

/** Who hears about this campaign: the client's contact, or its first owner. */
export async function campaignContact(db: Database, organizationId: string): Promise<{ email: string; name: string | null } | null> {
  const [client] = await db
    .select({ email: clients.primaryContactEmail, name: clients.primaryContactName })
    .from(clients)
    .where(eq(clients.organizationId, organizationId))
    .limit(1);
  if (client?.email) return { email: client.email, name: client.name };

  const [owner] = await db
    .select({ email: users.email, name: users.name })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(and(eq(organizationMemberships.organizationId, organizationId), isNotNull(users.email)))
    .orderBy(asc(organizationMemberships.createdAt))
    .limit(1);
  return owner ? { email: owner.email, name: owner.name } : null;
}

export function campaignUrl(publicId: string): string {
  const base = (process.env.AUTH_URL ?? "").replace(/\/$/, "");
  return `${base}/dashboard/growth/ads/${publicId}`;
}

/** Send, and say what happened; a failed email never undoes the change it reports. */
export async function tellClient(db: Database, organizationId: string, build: (contactName: string | null) => EmailMessage) {
  const contact = await campaignContact(db, organizationId);
  if (!contact) return { status: "skipped" as const, reason: "no_contact" };
  const message = build(contact.name);
  const result = await sendEmail({ ...message, to: contact.email });
  if (result.status === "failed") console.error("[ads] client email failed", { error: result.error });
  return result;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ReviewOutcome = { ok: true } | { ok: false; message: string };

/**
 * The ad-policy check: approve it for launch, or send it back with a reason
 * the client is shown word for word. Only a paid campaign waiting for review
 * can be decided, so a double click cannot decide one twice.
 */
export async function reviewCampaign(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  input: { approve: boolean; note: string },
  { now = new Date() }: { now?: Date } = {},
): Promise<ReviewOutcome> {
  const note = input.note.trim().slice(0, 1000);
  if (!input.approve && !note) {
    return { ok: false, message: "Say what has to change. The client sees this note." };
  }

  const [moved] = await db
    .update(adCampaigns)
    .set({
      status: input.approve ? "approved" : "rejected",
      reviewNote: input.approve ? null : note,
      reviewedBy: ctx.userId,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(and(eq(adCampaigns.publicId, publicId), eq(adCampaigns.status, "pending_review")))
    .returning({ organizationId: adCampaigns.organizationId, name: adCampaigns.name });

  if (!moved) return { ok: false, message: "This campaign isn't waiting for review." };

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: moved.organizationId,
    action: input.approve ? "ads.campaign_approved" : "ads.campaign_rejected",
    entityType: "ad_campaign",
    entityId: publicId,
    metadata: input.approve ? {} : { note },
  });

  if (!input.approve) {
    await tellClient(db, moved.organizationId, (contactName) =>
      buildAdNeedsChangesEmail({ contactName, campaignName: moved.name, campaignUrl: campaignUrl(publicId), note }),
    );
  }

  return { ok: true };
}
