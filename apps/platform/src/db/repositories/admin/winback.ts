import { and, count, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  users,
  winbackCampaigns,
  winbackRecipients,
  winbackSuppressions,
} from "@/db/schema";
import type { ResendEvent } from "@/lib/email/resend-webhook";
import { ORGANIZATION_TAG } from "@/lib/email/tags";
import { RECIPIENT_TAG } from "@/lib/winback/email";
import { EMPTY_STATS, statsFor, type CampaignStats } from "../winback-stats";
import type { AdminContext } from "../context";

/**
 * Win-back across every client: the operator's view and kill switch, plus
 * the two things that arrive with no session at all — a customer
 * unsubscribing, and Resend reporting what happened to an email.
 */

// ---------------------------------------------------------------------------
// The operator's view
// ---------------------------------------------------------------------------

export interface AdminCampaignRow {
  publicId: string;
  organizationId: string;
  clientPublicId: string | null;
  businessName: string;
  name: string;
  subject: string;
  status: string;
  scheduledFor: Date | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  sentAt: Date | null;
  haltedAt: Date | null;
  haltReason: string | null;
  stats: CampaignStats;
}

/** Every campaign a client has approved, newest first. Drafts are the client's own business. */
export async function listWinbackCampaigns(_ctx: AdminContext, db: Database, limit = 200): Promise<AdminCampaignRow[]> {
  const rows = await db
    .select({
      id: winbackCampaigns.id,
      publicId: winbackCampaigns.publicId,
      organizationId: winbackCampaigns.organizationId,
      clientPublicId: clients.publicId,
      orgName: organizations.name,
      fromName: winbackCampaigns.fromName,
      name: winbackCampaigns.name,
      subject: winbackCampaigns.subject,
      status: winbackCampaigns.status,
      scheduledFor: winbackCampaigns.scheduledFor,
      approvedAt: winbackCampaigns.approvedAt,
      approvedByName: users.name,
      approvedByEmail: users.email,
      sentAt: winbackCampaigns.sentAt,
      haltedAt: winbackCampaigns.haltedAt,
      haltReason: winbackCampaigns.haltReason,
    })
    .from(winbackCampaigns)
    .innerJoin(organizations, eq(organizations.id, winbackCampaigns.organizationId))
    .leftJoin(clients, eq(clients.organizationId, winbackCampaigns.organizationId))
    .leftJoin(users, eq(users.id, winbackCampaigns.approvedBy))
    .where(ne(winbackCampaigns.status, "draft"))
    .orderBy(desc(winbackCampaigns.approvedAt), desc(winbackCampaigns.createdAt))
    .limit(limit);

  const stats = await statsFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    publicId: r.publicId,
    organizationId: r.organizationId,
    clientPublicId: r.clientPublicId,
    businessName: r.fromName ?? r.orgName,
    name: r.name,
    subject: r.subject,
    status: r.status,
    scheduledFor: r.scheduledFor,
    approvedAt: r.approvedAt,
    approvedByName: r.approvedByName ?? r.approvedByEmail ?? null,
    sentAt: r.sentAt,
    haltedAt: r.haltedAt,
    haltReason: r.haltReason,
    stats: stats.get(r.id) ?? EMPTY_STATS,
  }));
}

export type HaltResult = { ok: true; message: string } | { ok: false; message: string };

const LIVE: Array<"approved" | "sending"> = ["approved", "sending"];

async function haltIds(ctx: AdminContext, db: Database, ids: string[], reason: string, now: Date): Promise<number> {
  if (ids.length === 0) return 0;
  const halted = await db
    .update(winbackCampaigns)
    .set({ status: "halted", haltedAt: now, haltedBy: ctx.userId, haltReason: reason, updatedAt: now })
    .where(and(inArray(winbackCampaigns.id, ids), inArray(winbackCampaigns.status, LIVE)))
    .returning({ id: winbackCampaigns.id, publicId: winbackCampaigns.publicId, organizationId: winbackCampaigns.organizationId });
  if (halted.length === 0) return 0;

  await db
    .update(winbackRecipients)
    .set({ status: "halted", updatedAt: now })
    .where(
      and(
        inArray(winbackRecipients.campaignId, halted.map((h) => h.id)),
        eq(winbackRecipients.status, "pending"),
      ),
    );
  await db.insert(auditLog).values(
    halted.map((h) => ({
      action: "winback.campaign_halted",
      entityType: "winback_campaign",
      entityId: h.publicId,
      actorUserId: ctx.userId,
      organizationId: h.organizationId,
      metadata: { reason },
    })),
  );
  return halted.length;
}

function reasonOf(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "Stopped by Mortensen Web Co.";
}

/** The kill switch for one campaign. The sender re-reads the status before every email. */
export async function haltCampaign(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  reason: string,
  now: Date = new Date(),
): Promise<HaltResult> {
  const [row] = await db
    .select({ id: winbackCampaigns.id })
    .from(winbackCampaigns)
    .where(eq(winbackCampaigns.publicId, publicId))
    .limit(1);
  if (!row) return { ok: false, message: "That campaign does not exist." };
  const n = await haltIds(ctx, db, [row.id], reasonOf(reason), now);
  return n > 0 ? { ok: true, message: "Stopped. Nobody else will get it." } : { ok: false, message: "It isn't sending or scheduled." };
}

/** Every scheduled or sending campaign, for every client, at once. */
export async function haltAllWinback(
  ctx: AdminContext,
  db: Database,
  reason: string,
  now: Date = new Date(),
): Promise<{ halted: number }> {
  const live = await db
    .select({ id: winbackCampaigns.id })
    .from(winbackCampaigns)
    .where(inArray(winbackCampaigns.status, LIVE));
  return { halted: await haltIds(ctx, db, live.map((r) => r.id), reasonOf(reason), now) };
}

// ---------------------------------------------------------------------------
// Unsubscribe — no session; the signed token in the link is the authority
// ---------------------------------------------------------------------------

/**
 * Per hashed IP, per hour. A real person unsubscribes from one or two
 * businesses; a script working through leaked links does not. Every token is
 * already signed, so this bounds damage rather than preventing forgery.
 */
export const UNSUBSCRIBES_PER_IP_PER_HOUR = 20;

async function recipientByPublicId(db: Database, publicId: string) {
  const [row] = await db
    .select({
      id: winbackRecipients.id,
      campaignId: winbackRecipients.campaignId,
      organizationId: winbackRecipients.organizationId,
      email: winbackRecipients.email,
      unsubscribedAt: winbackRecipients.unsubscribedAt,
      businessName: winbackCampaigns.fromName,
      orgName: organizations.name,
    })
    .from(winbackRecipients)
    .innerJoin(winbackCampaigns, eq(winbackCampaigns.id, winbackRecipients.campaignId))
    .innerJoin(organizations, eq(organizations.id, winbackRecipients.organizationId))
    .where(eq(winbackRecipients.publicId, publicId))
    .limit(1);
  return row ?? null;
}

async function isSuppressed(db: Database, organizationId: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: winbackSuppressions.id })
    .from(winbackSuppressions)
    .where(and(eq(winbackSuppressions.organizationId, organizationId), eq(winbackSuppressions.email, email)))
    .limit(1);
  return Boolean(row);
}

/** For the confirmation page: whose emails, and whether it is already done. */
export async function describeUnsubscribe(
  db: Database,
  recipientPublicId: string,
): Promise<{ businessName: string; done: boolean } | null> {
  const row = await recipientByPublicId(db, recipientPublicId);
  if (!row) return null;
  return {
    businessName: row.businessName ?? row.orgName,
    done: row.unsubscribedAt !== null || (await isSuppressed(db, row.organizationId, row.email)),
  };
}

export type UnsubscribeResult =
  | { ok: true; businessName: string }
  | { ok: false; reason: "not_found" | "rate_limited" };

/** Idempotent: a second click, or a mail app's one-click POST after the page's, changes nothing. */
export async function unsubscribeRecipient(
  db: Database,
  recipientPublicId: string,
  { ipHash, now = new Date() }: { ipHash: string | null; now?: Date },
): Promise<UnsubscribeResult> {
  const row = await recipientByPublicId(db, recipientPublicId);
  if (!row) return { ok: false, reason: "not_found" };
  const businessName = row.businessName ?? row.orgName;

  if (row.unsubscribedAt === null && ipHash) {
    const [recent] = await db
      .select({ n: count() })
      .from(winbackSuppressions)
      .where(
        and(
          eq(winbackSuppressions.ipHash, ipHash),
          gte(winbackSuppressions.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        ),
      );
    if ((recent?.n ?? 0) >= UNSUBSCRIBES_PER_IP_PER_HOUR) return { ok: false, reason: "rate_limited" };
  }

  await db
    .insert(winbackSuppressions)
    .values({
      organizationId: row.organizationId,
      email: row.email,
      reason: "unsubscribed",
      campaignId: row.campaignId,
      ipHash,
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .update(winbackRecipients)
    .set({ unsubscribedAt: now, updatedAt: now })
    .where(and(eq(winbackRecipients.id, row.id), isNull(winbackRecipients.unsubscribedAt)));
  return { ok: true, businessName };
}

// ---------------------------------------------------------------------------
// Resend's delivery events, routed here by `delivery-events.ts`
// ---------------------------------------------------------------------------

const STAMP = {
  delivered: "deliveredAt",
  opened: "openedAt",
  clicked: "clickedAt",
  bounced: "bouncedAt",
  complained: "complainedAt",
} as const;

/**
 * Record a delivery event on the send it belongs to.
 *
 * Found by Resend's email id first, and by the recipient tag when the id was
 * never recorded (a crash between Resend accepting the email and the row
 * being settled). The organization tag must match the row: a valid signature
 * proves the event came from Resend, not that its tags name the right
 * business.
 *
 * Each timestamp is set once, the first time. A click implies the email was
 * opened and delivered, and an open that it was delivered, so those are
 * filled in too when Resend's own event for them was lost or never sent
 * (opens are only reported when the image loads).
 */
export async function applyWinbackEvent(db: Database, event: ResendEvent): Promise<void> {
  const organizationId = event.tags[ORGANIZATION_TAG];
  const recipientTag = event.tags[RECIPIENT_TAG];
  const [row] = await db
    .select({
      id: winbackRecipients.id,
      organizationId: winbackRecipients.organizationId,
      campaignId: winbackRecipients.campaignId,
      email: winbackRecipients.email,
      deliveredAt: winbackRecipients.deliveredAt,
      openedAt: winbackRecipients.openedAt,
      clickedAt: winbackRecipients.clickedAt,
      bouncedAt: winbackRecipients.bouncedAt,
      complainedAt: winbackRecipients.complainedAt,
    })
    .from(winbackRecipients)
    .where(
      or(
        eq(winbackRecipients.providerMessageId, event.emailId),
        recipientTag ? eq(winbackRecipients.publicId, recipientTag) : undefined,
      ),
    )
    .limit(1);
  if (!row || (organizationId && organizationId !== row.organizationId)) return;

  const at = event.at;
  const patch: Partial<Record<(typeof STAMP)[keyof typeof STAMP], Date>> = {};
  const fill = (key: (typeof STAMP)[keyof typeof STAMP]) => {
    if (row[key] === null) patch[key] = at;
  };
  fill(STAMP[event.type]);
  if (event.type === "opened" || event.type === "clicked") fill("deliveredAt");
  if (event.type === "clicked") fill("openedAt");

  if (Object.keys(patch).length > 0) {
    await db.update(winbackRecipients).set({ ...patch, updatedAt: new Date() }).where(eq(winbackRecipients.id, row.id));
  }

  if (event.type === "bounced" || event.type === "complained") {
    await db
      .insert(winbackSuppressions)
      .values({
        organizationId: row.organizationId,
        email: row.email,
        reason: event.type,
        campaignId: row.campaignId,
      })
      .onConflictDoNothing();
  }
}
