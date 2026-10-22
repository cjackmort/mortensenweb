import { and, count, desc, eq, gte, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  businessProfiles,
  leads,
  organizations,
  reviewRequests,
  reviewSettings,
  reviewSuppressions,
  users,
} from "@/db/schema";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { replySenderAddress } from "@/lib/growth/lead-reply";
import { newPublicId } from "@/lib/ids";
import { firstName, normalizeEmail, normalizePhone } from "@/lib/reviews/contact";
import { deliverReviewRequest, type ChannelOutcome } from "@/lib/reviews/deliver";
import { reviewIdentity } from "@/lib/reviews/identity";
import { reviewLinks } from "@/lib/reviews/links";
import { sendSms, smsConfigured, type SmsResult } from "@/lib/reviews/sms";
import { effectiveTemplate } from "@/lib/reviews/template";
import { formatDate } from "@/lib/time";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * Asking one customer for a review: the "one click" on the dashboard.
 *
 * Refusals come first and are worded for the client. Then the request is
 * recorded, sent, and its outcome recorded — in that order, so a send that
 * succeeds is never left without the row its links point at, and a send that
 * fails still shows on the list.
 *
 * What decides each channel:
 *  - **Email** whenever there is an address the business has not been asked
 *    to stop using.
 *  - **Text** only when Twilio is set up, the client ticked that the customer
 *    agreed to a text, and the number is not suppressed. The consent is
 *    recorded on the row with who confirmed it; the table refuses a text
 *    without it.
 */

/** Per business, per hour. Generous for a busy day; a ceiling on a stolen session. */
export const REQUESTS_PER_HOUR = 60;
/** One request (and its one reminder) per customer in this many days. */
export const REPEAT_WINDOW_DAYS = 30;
const MAX_NAME_LENGTH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SendReviewInput {
  name?: string;
  email?: string;
  phone?: string;
  smsConsent?: boolean;
  /** A lead from the business's own inbox to take the details from. */
  leadPublicId?: string;
}

export type SendReviewResult =
  | { ok: true; publicId: string; emailStatus: string | null; smsStatus: string | null }
  | { ok: false; message: string };

interface SendDeps {
  send?: (message: EmailMessage) => Promise<SendResult>;
  text?: (message: { to: string; body: string }) => Promise<SmsResult>;
  smsEnabled?: boolean;
  now?: Date;
  env?: Record<string, string | undefined>;
}

const refuse = (message: string): SendReviewResult => ({ ok: false, message });

async function fromLead(db: Database, ctx: TenantContext, publicId: string) {
  const [lead] = await db
    .select({ id: leads.id, name: leads.name, email: leads.email, phone: leads.phone })
    .from(leads)
    .where(and(eq(leads.publicId, publicId), eq(leads.organizationId, ctx.organizationId), isNull(leads.deletedAt)))
    .limit(1);
  if (!lead) throw new NotFoundError();
  return lead;
}

async function suppressed(db: Database, ctx: TenantContext, email: string | null, phone: string | null) {
  const matches: SQL[] = [];
  if (email) matches.push(and(eq(reviewSuppressions.channel, "email"), eq(reviewSuppressions.address, email))!);
  if (phone) matches.push(and(eq(reviewSuppressions.channel, "sms"), eq(reviewSuppressions.address, phone))!);
  if (matches.length === 0) return { email: false, sms: false };
  const rows = await db
    .select({ channel: reviewSuppressions.channel })
    .from(reviewSuppressions)
    .where(and(eq(reviewSuppressions.organizationId, ctx.organizationId), or(...matches)));
  return { email: rows.some((r) => r.channel === "email"), sms: rows.some((r) => r.channel === "sms") };
}

async function askedRecently(db: Database, ctx: TenantContext, email: string | null, phone: string | null, now: Date) {
  const same: SQL[] = [];
  if (email) same.push(eq(reviewRequests.email, email));
  if (phone) same.push(eq(reviewRequests.phone, phone));
  const [row] = await db
    .select({ sentAt: reviewRequests.sentAt })
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.organizationId, ctx.organizationId),
        // Only a request that went out: one that failed can be tried again.
        isNotNull(reviewRequests.sentAt),
        gte(reviewRequests.sentAt, new Date(now.getTime() - REPEAT_WINDOW_DAYS * DAY_MS)),
        or(...same),
      ),
    )
    .orderBy(desc(reviewRequests.sentAt))
    .limit(1);
  return row?.sentAt ?? null;
}

/** Who requests go out as, and where replies land — also shown on the page before sending. */
export async function reviewSenderIdentity(db: Database, ctx: TenantContext) {
  const [org] = await db
    .select({ name: organizations.name, details: businessProfiles.details })
    .from(organizations)
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, organizations.id))
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  return reviewIdentity({ organizationName: org?.name ?? null, details: org?.details, fallbackEmail: me?.email });
}

export async function sendReviewRequest(
  db: Database,
  ctx: TenantContext,
  input: SendReviewInput,
  {
    send = sendEmail,
    text = sendSms,
    smsEnabled = smsConfigured(),
    now = new Date(),
    env = process.env,
  }: SendDeps = {},
): Promise<SendReviewResult> {
  assertMutable(ctx);

  const [settings] = await db
    .select()
    .from(reviewSettings)
    .where(eq(reviewSettings.organizationId, ctx.organizationId))
    .limit(1);
  if (!settings) return refuse("Set up your Google review link first.");

  const lead = input.leadPublicId ? await fromLead(db, ctx, input.leadPublicId) : null;
  const name = (input.name?.trim() || lead?.name?.trim() || "").slice(0, MAX_NAME_LENGTH);
  const rawEmail = input.email?.trim() || lead?.email?.trim() || "";
  const rawPhone = input.phone?.trim() || lead?.phone?.trim() || "";
  const email = normalizeEmail(rawEmail);
  const phone = normalizePhone(rawPhone);

  if (!name) return refuse("Add the customer's name.");
  if (rawEmail && !email) return refuse("That email address does not look right.");
  if (rawPhone && !phone) return refuse("That phone number does not look right.");
  if (!email && !phone) return refuse("Add an email address to send it to.");
  if (phone && !email && !smsEnabled) return refuse("Texting is not set up yet. Add their email address instead.");
  if (phone && !email && !input.smsConsent) {
    return refuse("Tick the box to confirm they agreed to a text from you, or add their email address.");
  }

  const wantsSms = Boolean(phone && smsEnabled && input.smsConsent);
  const blocked = await suppressed(db, ctx, email, phone);
  const useEmail = Boolean(email && !blocked.email);
  const useSms = wantsSms && !blocked.sms;
  if (!useEmail && !useSms) return refuse(`${firstName(name)} asked not to get review requests from you.`);

  const previous = await askedRecently(db, ctx, email, phone, now);
  if (previous) {
    return refuse(`You already asked ${firstName(name)} on ${formatDate(previous)}. One request and one reminder is plenty.`);
  }

  const [recent] = await db
    .select({ n: count() })
    .from(reviewRequests)
    .where(
      and(eq(reviewRequests.organizationId, ctx.organizationId), gte(reviewRequests.createdAt, new Date(now.getTime() - 60 * 60 * 1000))),
    );
  if ((recent?.n ?? 0) >= REQUESTS_PER_HOUR) return refuse("That's a lot of requests in an hour. Please wait a little and try again.");

  const senderAddress = replySenderAddress(env);
  if (useEmail && !senderAddress) return refuse("Sending isn't switched on yet. Please contact us.");
  const publicId = newPublicId();
  if (!(await reviewLinks(publicId, env))) return refuse("Review links aren't switched on yet. Please contact us.");

  const identity = await reviewSenderIdentity(db, ctx);
  const [row] = await db
    .insert(reviewRequests)
    .values({
      publicId,
      organizationId: ctx.organizationId,
      leadId: lead?.id ?? null,
      createdBy: ctx.userId,
      customerName: name,
      email,
      phone,
      smsConsentAt: phone && input.smsConsent ? now : null,
      smsConsentBy: phone && input.smsConsent ? ctx.userId : null,
      fromName: identity.businessName,
      replyTo: identity.replyTo,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: reviewRequests.id });

  const delivered = await deliverReviewRequest(
    {
      publicId,
      customerName: name,
      email,
      phone,
      useEmail,
      useSms,
      ...identity,
      senderAddress,
      template: effectiveTemplate(settings),
      reminder: false,
    },
    { send, text, env },
  );

  if (delivered.smsOptedOut && phone) {
    await db
      .insert(reviewSuppressions)
      .values({ organizationId: ctx.organizationId, channel: "sms", address: phone, reason: "sms_opt_out", requestId: row!.id })
      .onConflictDoNothing();
  }

  const emailStatus = useEmail ? delivered.email : email ? "suppressed" : null;
  const smsStatus = useSms ? (delivered.smsOptedOut ? "suppressed" : delivered.sms) : wantsSms ? "suppressed" : null;
  const statuses: (string | null)[] = [emailStatus, smsStatus];
  const anySent = statuses.includes("sent");

  await db
    .update(reviewRequests)
    .set({
      emailStatus,
      smsStatus,
      sentAt: anySent ? now : null,
      reminderDueAt: anySent && settings.remindersEnabled ? new Date(now.getTime() + settings.reminderDays * DAY_MS) : null,
      error: delivered.error,
      updatedAt: now,
    })
    .where(eq(reviewRequests.id, row!.id));

  if (!anySent && statuses.includes("failed" satisfies ChannelOutcome)) {
    return refuse("It could not be sent. Please try again in a minute.");
  }
  if (!anySent && delivered.smsOptedOut && !useEmail) {
    return refuse(`${firstName(name)} has opted out of texts from you.`);
  }
  return { ok: true, publicId, emailStatus, smsStatus };
}
