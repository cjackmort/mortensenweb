import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  businessProfiles,
  clients,
  organizations,
  users,
  winbackCampaigns,
  winbackRecipients,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { BusinessDetails } from "@/lib/business-profile";
import { businessTimeZone, formatDateWithYear } from "@/lib/time";
import { validateCampaignText, type CampaignTextInput } from "@/lib/winback/email";
import {
  businessTypeOf,
  composeDraft,
  OCCASIONS,
  suggestOccasions,
  type BusinessType,
  type Occasion,
} from "@/lib/winback/occasions";
import { MISSING_MESSAGE, sendingReadiness, sendTimeFor, type Readiness } from "@/lib/winback/readiness";
import { EMPTY_STATS, statsFor, type CampaignStats } from "../winback-stats";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { countReachable } from "./winback-contacts";

/**
 * Win-back campaigns, tenant-scoped: proposed, edited, approved, cancelled.
 *
 * Nothing here sends. Approval is the only way out of `draft`, it is a person
 * in the client's organization pressing a button (`assertMutable` refuses an
 * operator viewing as them), and it fixes the text: what goes out is what was
 * approved. The sending itself is `admin/winback-sender.ts`, on the scheduler.
 */

export type CampaignStatus = "draft" | "approved" | "sending" | "sent" | "cancelled" | "halted";

/** A seasonal suggestion stays used for this long once drafted, so next year it comes back. */
const SUGGESTION_COOLDOWN_DAYS = 180;
/** How far ahead a send can be scheduled. */
const MAX_SCHEDULE_DAYS = 365;

export type Result = { ok: true; message: string } | { ok: false; message: string };

interface Business {
  details: BusinessDetails;
  industry: string | null;
  userEmail: string | null;
}

async function businessOf(db: Database, ctx: TenantContext): Promise<Business> {
  const [org] = await db
    .select({ name: organizations.name, details: businessProfiles.details, industry: clients.industry })
    .from(organizations)
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, organizations.id))
    .leftJoin(clients, eq(clients.organizationId, organizations.id))
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  const details = { ...(org?.details ?? {}) };
  if (!details.businessName?.trim() && org?.name) details.businessName = org.name;
  return { details, industry: org?.industry ?? null, userEmail: me?.email ?? null };
}

function readinessOf(business: Business): Readiness {
  return sendingReadiness({ details: business.details, fallbackReplyTo: business.userEmail });
}

function today(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: businessTimeZone() });
}

export interface CampaignSummary {
  publicId: string;
  name: string;
  subject: string;
  status: CampaignStatus;
  scheduledFor: Date | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  stats: CampaignStats;
}

export interface WinbackOverview {
  businessType: BusinessType;
  suggestions: Occasion[];
  campaigns: CampaignSummary[];
  reachable: number;
  readiness: Readiness;
}

export async function winbackOverview(db: Database, ctx: TenantContext, now: Date = new Date()): Promise<WinbackOverview> {
  const business = await businessOf(db, ctx);
  const rows = await db
    .select({
      id: winbackCampaigns.id,
      publicId: winbackCampaigns.publicId,
      name: winbackCampaigns.name,
      subject: winbackCampaigns.subject,
      status: winbackCampaigns.status,
      occasionKey: winbackCampaigns.occasionKey,
      scheduledFor: winbackCampaigns.scheduledFor,
      approvedAt: winbackCampaigns.approvedAt,
      sentAt: winbackCampaigns.sentAt,
      createdAt: winbackCampaigns.createdAt,
    })
    .from(winbackCampaigns)
    .where(eq(winbackCampaigns.organizationId, ctx.organizationId))
    .orderBy(desc(winbackCampaigns.createdAt));

  const stats = await statsFor(
    db,
    rows.map((r) => r.id),
    eq(winbackRecipients.organizationId, ctx.organizationId),
  );

  const since = now.getTime() - SUGGESTION_COOLDOWN_DAYS * 86_400_000;
  const used = new Set(
    rows.filter((r) => r.status !== "cancelled" && r.createdAt.getTime() >= since).map((r) => r.occasionKey),
  );
  const businessType = businessTypeOf({ industry: business.industry, details: business.details });
  // "It's been a while" is never used up: it is the one that fits any time.
  const suggestions = suggestOccasions(businessType, now).filter((o) => !o.types === true || !used.has(o.key));

  return {
    businessType,
    suggestions,
    campaigns: rows.map((r) => ({
      publicId: r.publicId,
      name: r.name,
      subject: r.subject,
      status: r.status as CampaignStatus,
      scheduledFor: r.scheduledFor,
      approvedAt: r.approvedAt,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
      stats: stats.get(r.id) ?? EMPTY_STATS,
    })),
    reachable: await countReachable(db, ctx.organizationId),
    readiness: readinessOf(business),
  };
}

export async function createDraft(db: Database, ctx: TenantContext, occasionKey: string): Promise<string> {
  assertMutable(ctx);
  const occasion = OCCASIONS.find((o) => o.key === occasionKey);
  if (!occasion) throw new NotFoundError();
  const business = await businessOf(db, ctx);
  const draft = composeDraft(occasion, business.details);
  const publicId = newPublicId();
  await db.insert(winbackCampaigns).values({
    publicId,
    organizationId: ctx.organizationId,
    occasionKey: occasion.key,
    name: occasion.label,
    subject: draft.subject,
    body: draft.body,
    offer: draft.offer,
    createdBy: ctx.userId,
  });
  return publicId;
}

export interface CampaignDetail extends CampaignSummary {
  occasionKey: string;
  body: string;
  offer: string | null;
  offerExpiresOn: string | null;
  approvedByName: string | null;
  sendStartedAt: Date | null;
  haltedAt: Date | null;
  haltReason: string | null;
  /** As approved; null on a draft. */
  fromName: string | null;
  replyTo: string | null;
  postalAddress: string | null;
}

async function campaignRow(db: Database, ctx: TenantContext, publicId: string) {
  const [row] = await db
    .select()
    .from(winbackCampaigns)
    .where(and(eq(winbackCampaigns.publicId, publicId), eq(winbackCampaigns.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

export async function getCampaign(db: Database, ctx: TenantContext, publicId: string): Promise<CampaignDetail> {
  const row = await campaignRow(db, ctx, publicId);
  const [approver] = row.approvedBy
    ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.approvedBy)).limit(1)
    : [];
  const stats = await statsFor(db, [row.id], eq(winbackRecipients.organizationId, ctx.organizationId));
  return {
    publicId: row.publicId,
    name: row.name,
    subject: row.subject,
    status: row.status as CampaignStatus,
    scheduledFor: row.scheduledFor,
    approvedAt: row.approvedAt,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
    stats: stats.get(row.id) ?? EMPTY_STATS,
    occasionKey: row.occasionKey,
    body: row.body,
    offer: row.offer,
    offerExpiresOn: row.offerExpiresOn,
    approvedByName: approver?.name ?? approver?.email ?? null,
    sendStartedAt: row.sendStartedAt,
    haltedAt: row.haltedAt,
    haltReason: row.haltReason,
    fromName: row.fromName,
    replyTo: row.replyTo,
    postalAddress: row.postalAddress,
  };
}

/** Who it will come from and the footer it will carry, as of now — for the draft's preview. */
export async function sendingIdentity(db: Database, ctx: TenantContext): Promise<Readiness & { fromName: string }> {
  const business = await businessOf(db, ctx);
  return { ...readinessOf(business), fromName: business.details.businessName?.trim() || "Your business" };
}

export type SaveResult =
  | { ok: true; message: string }
  | { ok: false; message: string; errors?: Partial<Record<keyof CampaignTextInput, string>> };

function firstError(errors: Partial<Record<string, string>>): string {
  return Object.values(errors)[0] ?? "Check the email.";
}

export async function saveDraft(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: CampaignTextInput,
  now: Date = new Date(),
): Promise<SaveResult> {
  assertMutable(ctx);
  const row = await campaignRow(db, ctx, publicId);
  if (row.status !== "draft") return { ok: false, message: "This one is approved, so it can't be changed. Cancel it and start a new draft." };
  const checked = validateCampaignText(input, now);
  if (!checked.ok) return { ok: false, message: firstError(checked.errors), errors: checked.errors };

  await db
    .update(winbackCampaigns)
    .set({ ...checked.value, updatedAt: now })
    .where(and(eq(winbackCampaigns.id, row.id), eq(winbackCampaigns.status, "draft")));
  return { ok: true, message: "Saved." };
}

export async function deleteDraft(db: Database, ctx: TenantContext, publicId: string): Promise<void> {
  assertMutable(ctx);
  const deleted = await db
    .delete(winbackCampaigns)
    .where(
      and(
        eq(winbackCampaigns.publicId, publicId),
        eq(winbackCampaigns.organizationId, ctx.organizationId),
        eq(winbackCampaigns.status, "draft"),
      ),
    )
    .returning({ id: winbackCampaigns.id });
  if (deleted.length === 0) throw new NotFoundError();
}

async function audit(db: Database, ctx: TenantContext, action: string, publicId: string, metadata: Record<string, unknown>) {
  await db.insert(auditLog).values({
    action,
    entityType: "winback_campaign",
    entityId: publicId,
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata,
  });
}

/**
 * Approve a draft, with the text as it is on the screen.
 *
 * Every refusal names what to do about it. The checks are the ones the
 * sender repeats before it sends, so a campaign that passes here is one the
 * sender will not later refuse for a reason the client could have fixed.
 */
export async function approveCampaign(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: CampaignTextInput & { scheduleDay: string },
  now: Date = new Date(),
): Promise<SaveResult & { sendsNow?: boolean }> {
  assertMutable(ctx);
  const row = await campaignRow(db, ctx, publicId);
  if (row.status !== "draft") return { ok: false, message: "This one has already been approved." };

  const checked = validateCampaignText(input, now);
  if (!checked.ok) return { ok: false, message: firstError(checked.errors), errors: checked.errors };

  const business = await businessOf(db, ctx);
  const readiness = readinessOf(business);
  if (!readiness.ready) return { ok: false, message: MISSING_MESSAGE[readiness.missing[0]!] };

  const reachable = await countReachable(db, ctx.organizationId);
  if (reachable === 0) {
    return { ok: false, message: "You have no customers to send this to yet. Add them under Customers first." };
  }

  const day = input.scheduleDay.trim();
  const todayIs = today(now);
  let scheduledFor: Date | null = null;
  if (day) {
    scheduledFor = sendTimeFor(day, businessTimeZone());
    if (!scheduledFor) return { ok: false, message: "Pick a day to send it, or leave it empty to send now." };
    if (day < todayIs) return { ok: false, message: "That day has passed. Pick today or a later day." };
    if (scheduledFor.getTime() - now.getTime() > MAX_SCHEDULE_DAYS * 86_400_000) {
      return { ok: false, message: "Pick a day within the next year." };
    }
  }
  const sendDay = day || todayIs;
  if (checked.value.offerExpiresOn && checked.value.offerExpiresOn < sendDay) {
    return { ok: false, message: "The offer ends before the email goes out. Move the end date, or the send date." };
  }

  const approved = await db
    .update(winbackCampaigns)
    .set({
      ...checked.value,
      status: "approved",
      scheduledFor,
      approvedAt: now,
      approvedBy: ctx.userId,
      fromName: business.details.businessName!.trim(),
      replyTo: readiness.replyTo,
      postalAddress: readiness.postalAddress,
      updatedAt: now,
    })
    .where(and(eq(winbackCampaigns.id, row.id), eq(winbackCampaigns.status, "draft")))
    .returning({ id: winbackCampaigns.id });
  if (approved.length === 0) return { ok: false, message: "This one has already been approved." };

  await audit(db, ctx, "winback.campaign_approved", publicId, {
    scheduledFor: scheduledFor?.toISOString() ?? null,
    reachable,
  });

  const sendsNow = !scheduledFor || scheduledFor.getTime() <= now.getTime();
  const who = `${reachable} ${reachable === 1 ? "customer" : "customers"}`;
  return {
    ok: true,
    sendsNow,
    message: sendsNow
      ? `Approved. It starts going out to ${who} in the next few minutes.`
      : `Approved. It goes out to ${who} on ${formatDateWithYear(scheduledFor!)}, from 9am.`,
  };
}

/** Take back an approved campaign. Anyone not yet emailed is not emailed. */
export async function cancelCampaign(db: Database, ctx: TenantContext, publicId: string, now: Date = new Date()): Promise<Result> {
  assertMutable(ctx);
  const row = await campaignRow(db, ctx, publicId);
  const cancelled = await db
    .update(winbackCampaigns)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(winbackCampaigns.id, row.id), inArray(winbackCampaigns.status, ["approved", "sending"])))
    .returning({ id: winbackCampaigns.id });
  if (cancelled.length === 0) return { ok: false, message: "This one can't be cancelled now." };

  await db
    .update(winbackRecipients)
    .set({ status: "halted", updatedAt: now })
    .where(and(eq(winbackRecipients.campaignId, row.id), eq(winbackRecipients.status, "pending")));
  await audit(db, ctx, "winback.campaign_cancelled", publicId, { was: row.status });

  return {
    ok: true,
    message: row.status === "sending" ? "Stopped. Nobody else will get it." : "Cancelled. Nobody will get it.",
  };
}

/** Campaigns approved or sending, for the "something is on its way" line on the Growth tab. */
export async function countActiveCampaigns(db: Database, ctx: TenantContext): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(winbackCampaigns)
    .where(
      and(
        eq(winbackCampaigns.organizationId, ctx.organizationId),
        inArray(winbackCampaigns.status, ["approved", "sending"]),
        ne(winbackCampaigns.status, "draft"),
        gte(winbackCampaigns.createdAt, new Date(0)),
      ),
    );
  return row?.n ?? 0;
}
