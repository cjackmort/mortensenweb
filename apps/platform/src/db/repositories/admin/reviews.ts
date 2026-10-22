import { and, asc, desc, eq, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  businessProfiles,
  clients,
  organizations,
  reviewRequests,
  reviewSettings,
  reviewSuppressions,
} from "@/db/schema";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { replySenderAddress } from "@/lib/growth/lead-reply";
import { deliverReviewRequest } from "@/lib/reviews/deliver";
import { reviewIdentity } from "@/lib/reviews/identity";
import { isWithinSendingHours } from "@/lib/reviews/sending-hours";
import { sendSms, smsConfigured, type SmsResult } from "@/lib/reviews/sms";
import { effectiveTemplate } from "@/lib/reviews/template";
import { businessTimeZone } from "@/lib/time";
import { NotFoundError, type AdminContext } from "../context";

/**
 * Review requests from the system's side: the public link, the unsubscribe
 * page and the scheduled reminder, none of which has a session. What scopes
 * each is the request's public id, recovered from a token we signed (see
 * `lib/reviews/tokens.ts`) — never anything else in the URL. Plus the
 * operator's read of one client's requests, behind an `AdminContext`.
 */

/** Reloads inside this window are one click, not several. */
const CLICK_DEBOUNCE_MS = 10_000;
/** Reminders per scheduler run; anything not reached goes on the next. */
const REMINDERS_PER_RUN = 25;

/**
 * Record a click on a review link and return where to send the customer: the
 * business's review form as it is set up *now*, so fixing a wrong link also
 * fixes every email already sent.
 */
export async function recordReviewClick(db: Database, publicId: string, now = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ id: reviewRequests.id, reviewUrl: reviewSettings.reviewUrl })
    .from(reviewRequests)
    .innerJoin(reviewSettings, eq(reviewSettings.organizationId, reviewRequests.organizationId))
    .where(eq(reviewRequests.publicId, publicId))
    .limit(1);
  if (!row) return null;

  const stamp = sql`${now.toISOString()}::timestamptz`;
  await db
    .update(reviewRequests)
    .set({
      clickCount: sql`${reviewRequests.clickCount} + 1`,
      firstClickedAt: sql`coalesce(${reviewRequests.firstClickedAt}, ${stamp})`,
      lastClickedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(reviewRequests.id, row.id),
        or(isNull(reviewRequests.lastClickedAt), lt(reviewRequests.lastClickedAt, new Date(now.getTime() - CLICK_DEBOUNCE_MS))),
      ),
    );
  return row.reviewUrl;
}

/** What the unsubscribe page needs to say: whose requests, and whether that is done already. */
export async function describeReviewStop(
  db: Database,
  publicId: string,
): Promise<{ businessName: string; unsubscribed: boolean } | null> {
  const [row] = await db
    .select({ fromName: reviewRequests.fromName, unsubscribedAt: reviewRequests.unsubscribedAt })
    .from(reviewRequests)
    .where(eq(reviewRequests.publicId, publicId))
    .limit(1);
  return row ? { businessName: row.fromName, unsubscribed: row.unsubscribedAt !== null } : null;
}

/**
 * The customer asked this business to stop. Every address the request knows
 * is suppressed — email and phone alike, whichever channel they clicked from
 * — because "stop" from a person means stop, not "stop on this channel".
 * Idempotent: a mail provider's one-click POST and the person's own click can
 * both arrive.
 */
export async function unsubscribeReviewRequest(
  db: Database,
  publicId: string,
  now = new Date(),
): Promise<{ businessName: string } | null> {
  const [row] = await db
    .select({
      id: reviewRequests.id,
      organizationId: reviewRequests.organizationId,
      email: reviewRequests.email,
      phone: reviewRequests.phone,
      fromName: reviewRequests.fromName,
    })
    .from(reviewRequests)
    .where(eq(reviewRequests.publicId, publicId))
    .limit(1);
  if (!row) return null;

  const entries = [
    ...(row.email ? [{ channel: "email", address: row.email }] : []),
    ...(row.phone ? [{ channel: "sms", address: row.phone }] : []),
  ].map((entry) => ({ ...entry, organizationId: row.organizationId, reason: "unsubscribed", requestId: row.id, createdAt: now }));
  if (entries.length > 0) await db.insert(reviewSuppressions).values(entries).onConflictDoNothing();

  await db
    .update(reviewRequests)
    .set({ unsubscribedAt: sql`coalesce(${reviewRequests.unsubscribedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
    .where(eq(reviewRequests.id, row.id));
  return { businessName: row.fromName };
}

export type ReminderRun =
  | { skipped: "outside sending hours" }
  | { due: number; sent: number; suppressed: number; failed: number; cancelled: number };

interface ReminderDeps {
  send?: (message: EmailMessage) => Promise<SendResult>;
  text?: (message: { to: string; body: string }) => Promise<SmsResult>;
  smsEnabled?: boolean;
  now?: Date;
  env?: Record<string, string | undefined>;
  timeZone?: string;
  limit?: number;
}

async function suppressedFor(db: Database, organizationId: string, email: string | null, phone: string | null) {
  const matches: SQL[] = [];
  if (email) matches.push(and(eq(reviewSuppressions.channel, "email"), eq(reviewSuppressions.address, email))!);
  if (phone) matches.push(and(eq(reviewSuppressions.channel, "sms"), eq(reviewSuppressions.address, phone))!);
  if (matches.length === 0) return { email: false, sms: false };
  const rows = await db
    .select({ channel: reviewSuppressions.channel })
    .from(reviewSuppressions)
    .where(and(eq(reviewSuppressions.organizationId, organizationId), or(...matches)));
  return { email: rows.some((r) => r.channel === "email"), sms: rows.some((r) => r.channel === "sms") };
}

/**
 * The one automatic reminder, for every request whose link went unclicked.
 *
 * Each is **claimed before it is sent**: `reminded_at` is set by an update
 * that only matches while it is still null, so two overlapping runs cannot
 * both send, and a run that dies mid-send leaves the request reminded rather
 * than eligible again. Suppression is checked at send time, not at request
 * time: someone who unsubscribed after the first email gets nothing more.
 *
 * Runs on the scheduler (`/api/cron`). Nothing nudges it: a reminder is days
 * away, and the six-hourly sweep is close enough.
 */
export async function runReviewReminders(
  db: Database,
  {
    send = sendEmail,
    text = sendSms,
    smsEnabled = smsConfigured(),
    now = new Date(),
    env = process.env,
    timeZone = businessTimeZone(),
    limit = REMINDERS_PER_RUN,
  }: ReminderDeps = {},
): Promise<ReminderRun> {
  if (!isWithinSendingHours(now, timeZone)) return { skipped: "outside sending hours" };

  const due = await db
    .select({
      id: reviewRequests.id,
      publicId: reviewRequests.publicId,
      organizationId: reviewRequests.organizationId,
      customerName: reviewRequests.customerName,
      email: reviewRequests.email,
      phone: reviewRequests.phone,
      emailStatus: reviewRequests.emailStatus,
      smsStatus: reviewRequests.smsStatus,
      smsConsentAt: reviewRequests.smsConsentAt,
      fromName: reviewRequests.fromName,
      replyTo: reviewRequests.replyTo,
      remindersEnabled: reviewSettings.remindersEnabled,
      emailSubject: reviewSettings.emailSubject,
      emailBody: reviewSettings.emailBody,
      reminderBody: reviewSettings.reminderBody,
      details: businessProfiles.details,
    })
    .from(reviewRequests)
    .innerJoin(reviewSettings, eq(reviewSettings.organizationId, reviewRequests.organizationId))
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, reviewRequests.organizationId))
    .where(
      and(
        lte(reviewRequests.reminderDueAt, now),
        isNull(reviewRequests.remindedAt),
        isNull(reviewRequests.firstClickedAt),
        isNull(reviewRequests.unsubscribedAt),
      ),
    )
    .orderBy(asc(reviewRequests.reminderDueAt))
    .limit(limit);

  const counts = { due: due.length, sent: 0, suppressed: 0, failed: 0, cancelled: 0 };

  for (const request of due) {
    if (!request.remindersEnabled) {
      // Switched off after this was sent. Cancelled rather than claimed, so
      // the list says "no reminder" instead of "reminded".
      await db
        .update(reviewRequests)
        .set({ reminderDueAt: null, updatedAt: now })
        .where(and(eq(reviewRequests.id, request.id), isNull(reviewRequests.remindedAt)));
      counts.cancelled += 1;
      continue;
    }

    const claimed = await db
      .update(reviewRequests)
      .set({ remindedAt: now, reminderStatus: "sending", updatedAt: now })
      .where(and(eq(reviewRequests.id, request.id), isNull(reviewRequests.remindedAt), isNull(reviewRequests.firstClickedAt)))
      .returning({ id: reviewRequests.id });
    if (claimed.length === 0) continue;

    const blocked = await suppressedFor(db, request.organizationId, request.email, request.phone);
    const useEmail = request.emailStatus === "sent" && Boolean(request.email) && !blocked.email;
    const useSms =
      request.smsStatus === "sent" && Boolean(request.phone) && request.smsConsentAt !== null && smsEnabled && !blocked.sms;

    let status: "sent" | "failed" | "not_sent" | "suppressed";
    let error: string | null = null;
    if (!useEmail && !useSms) {
      status = blocked.email || blocked.sms ? "suppressed" : "not_sent";
    } else {
      const identity = reviewIdentity({ organizationName: request.fromName, details: request.details });
      const delivered = await deliverReviewRequest(
        {
          publicId: request.publicId,
          customerName: request.customerName,
          email: request.email,
          phone: request.phone,
          useEmail,
          useSms,
          // As the first email was sent, so the reminder is plainly from the same business.
          businessName: request.fromName,
          replyTo: request.replyTo,
          postalAddress: identity.postalAddress,
          senderAddress: replySenderAddress(env),
          template: effectiveTemplate(request),
          reminder: true,
        },
        { send, text, env },
      );
      if (delivered.smsOptedOut && request.phone) {
        await db
          .insert(reviewSuppressions)
          .values({
            organizationId: request.organizationId,
            channel: "sms",
            address: request.phone,
            reason: "sms_opt_out",
            requestId: request.id,
          })
          .onConflictDoNothing();
      }
      const outcomes = [delivered.email, delivered.sms];
      status = outcomes.includes("sent")
        ? "sent"
        : outcomes.includes("failed")
          ? "failed"
          : delivered.smsOptedOut
            ? "suppressed"
            : "not_sent";
      error = delivered.error;
    }

    await db
      .update(reviewRequests)
      .set({ reminderStatus: status, error: error ?? undefined, updatedAt: now })
      .where(eq(reviewRequests.id, request.id));
    if (status === "sent") counts.sent += 1;
    else if (status === "suppressed") counts.suppressed += 1;
    else if (status === "failed") counts.failed += 1;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// The operator's view
// ---------------------------------------------------------------------------

export interface ClientReviewsView {
  setup: {
    reviewUrl: string;
    placeId: string | null;
    placeName: string | null;
    reminderDays: number;
    remindersEnabled: boolean;
    customised: boolean;
  } | null;
  sent: number;
  clicked: number;
  reminded: number;
  suppressed: number;
  recent: Array<{
    customerName: string;
    sentAt: Date | null;
    emailStatus: string | null;
    smsStatus: string | null;
    clickedAt: Date | null;
    reminderDueAt: Date | null;
    remindedAt: Date | null;
    reminderStatus: string | null;
    unsubscribedAt: Date | null;
    createdAt: Date;
  }>;
}

export async function getClientReviews(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<ClientReviewsView> {
  const [client] = await db
    .select({ organizationId: organizations.id })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!client) throw new NotFoundError();
  const org = client.organizationId;

  const [settings] = await db.select().from(reviewSettings).where(eq(reviewSettings.organizationId, org)).limit(1);
  const [counts] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${reviewRequests.sentAt} is not null)::int`,
      clicked: sql<number>`count(*) filter (where ${reviewRequests.sentAt} is not null and ${reviewRequests.firstClickedAt} is not null)::int`,
      reminded: sql<number>`count(*) filter (where ${reviewRequests.reminderStatus} = 'sent')::int`,
    })
    .from(reviewRequests)
    .where(eq(reviewRequests.organizationId, org));
  const [suppressions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewSuppressions)
    .where(eq(reviewSuppressions.organizationId, org));
  const recent = await db
    .select({
      customerName: reviewRequests.customerName,
      sentAt: reviewRequests.sentAt,
      emailStatus: reviewRequests.emailStatus,
      smsStatus: reviewRequests.smsStatus,
      clickedAt: reviewRequests.firstClickedAt,
      reminderDueAt: reviewRequests.reminderDueAt,
      remindedAt: reviewRequests.remindedAt,
      reminderStatus: reviewRequests.reminderStatus,
      unsubscribedAt: reviewRequests.unsubscribedAt,
      createdAt: reviewRequests.createdAt,
    })
    .from(reviewRequests)
    .where(eq(reviewRequests.organizationId, org))
    .orderBy(desc(reviewRequests.createdAt))
    .limit(10);

  return {
    setup: settings
      ? {
          reviewUrl: settings.reviewUrl,
          placeId: settings.placeId,
          placeName: settings.placeName,
          reminderDays: settings.reminderDays,
          remindersEnabled: settings.remindersEnabled,
          customised: Boolean(settings.emailSubject ?? settings.emailBody ?? settings.reminderBody),
        }
      : null,
    sent: Number(counts?.sent ?? 0),
    clicked: Number(counts?.clicked ?? 0),
    reminded: Number(counts?.reminded ?? 0),
    suppressed: Number(suppressions?.n ?? 0),
    recent,
  };
}
