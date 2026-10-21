import { and, desc, eq, isNull, or, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { leads, reviewRequests, reviewSettings, reviewSuppressions } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/reviews/contact";
import { getPlaceSummary, placesConfigured, type PlacesFailure, type PlaceSummary } from "@/lib/reviews/places";
import { parseReviewLink, reviewDestination, type ReviewDestination } from "@/lib/reviews/review-link";
import {
  DEFAULT_TEMPLATE,
  effectiveTemplate,
  validateTemplate,
  type ReviewTemplate,
} from "@/lib/reviews/template";
import { assertMutable, type TenantContext } from "../context";
import { getGoogleReviewLink } from "./google-profile";

/**
 * Review requests from the client's side, tenant-scoped: the one-time setup,
 * the list of who was asked and what happened, and the suppression list.
 * Sending is in `review-send.ts`; the public link and the reminders, which
 * have no session, are in `admin/reviews.ts`.
 */

export type ReviewResult = { ok: true; message: string } | { ok: false; message: string };

export interface ReviewSetup {
  reviewUrl: string;
  placeId: string | null;
  placeName: string | null;
  template: ReviewTemplate;
  /** Whether any of the wording is theirs rather than the default. */
  customised: boolean;
  reminderDays: number;
  remindersEnabled: boolean;
  updatedAt: Date;
}

export const MIN_REMINDER_DAYS = 1;
export const MAX_REMINDER_DAYS = 14;

export async function getReviewSetup(db: Database, ctx: TenantContext): Promise<ReviewSetup | null> {
  const [row] = await db
    .select()
    .from(reviewSettings)
    .where(eq(reviewSettings.organizationId, ctx.organizationId))
    .limit(1);
  if (!row) return null;
  return {
    reviewUrl: row.reviewUrl,
    placeId: row.placeId,
    placeName: row.placeName,
    template: effectiveTemplate(row),
    customised: Boolean(row.emailSubject ?? row.emailBody ?? row.reminderBody),
    reminderDays: row.reminderDays,
    remindersEnabled: row.remindersEnabled,
    updatedAt: row.updatedAt,
  };
}

/**
 * Where the "Leave a review" button sends this business's customers right
 * now: the review form Google gives its linked profile, or `enteredUrl` (the
 * link from its setup, null before it has one). The click itself is resolved
 * the same way in `admin/reviews.ts`, so what the page says is what happens.
 */
export async function getReviewDestination(
  db: Database,
  ctx: TenantContext,
  enteredUrl: string | null,
): Promise<ReviewDestination | null> {
  const profile = await getGoogleReviewLink(db, ctx);
  return reviewDestination(profile?.url, enteredUrl);
}

export type PlaceLookup = (placeId: string) => Promise<{ ok: true; place: PlaceSummary } | PlacesFailure>;

/**
 * Save the Google review link.
 *
 * A place id is checked with Google when the Places API is set up, so a typo
 * is caught here rather than by a customer landing on an error page. Google
 * being unreachable does not block saving: the id passed the format check,
 * and refusing a business's setup because Google hiccuped helps nobody.
 */
export async function saveReviewLink(
  db: Database,
  ctx: TenantContext,
  { input }: { input: string },
  { lookup = placesConfigured() ? getPlaceSummary : null, now = new Date() }: { lookup?: PlaceLookup | null; now?: Date } = {},
): Promise<ReviewResult> {
  assertMutable(ctx);
  const parsed = parseReviewLink(input);
  if (!parsed.ok) return parsed;

  let placeName: string | null = null;
  if (parsed.placeId && lookup) {
    const found = await lookup(parsed.placeId);
    if (!found.ok && found.reason === "not_found") {
      return {
        ok: false,
        message: "Google does not recognise that place ID. Check it, or paste the link from \"Ask for reviews\" instead.",
      };
    }
    if (found.ok) placeName = found.place.name;
  }

  await db
    .insert(reviewSettings)
    .values({
      organizationId: ctx.organizationId,
      reviewUrl: parsed.reviewUrl,
      placeId: parsed.placeId,
      placeName,
      updatedBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: reviewSettings.organizationId,
      set: { reviewUrl: parsed.reviewUrl, placeId: parsed.placeId, placeName, updatedBy: ctx.userId, updatedAt: now },
    });

  return {
    ok: true,
    message: placeName
      ? `Saved. Customers will go straight to the review form for ${placeName}.`
      : "Saved. Open the link below once to check it goes to your review form.",
  };
}

/** Text as stored: the same line endings everywhere, and null when it is the default. */
function storedText(value: string, fallback: string): string | null {
  const text = value.replace(/\r\n?/g, "\n").trim();
  return text === fallback ? null : text;
}

export async function saveReviewMessage(
  db: Database,
  ctx: TenantContext,
  input: ReviewTemplate & { reminderDays: number; remindersEnabled: boolean },
  { now = new Date() }: { now?: Date } = {},
): Promise<ReviewResult> {
  assertMutable(ctx);
  const template = {
    subject: input.subject.trim(),
    body: input.body.replace(/\r\n?/g, "\n").trim(),
    reminderBody: input.reminderBody.replace(/\r\n?/g, "\n").trim(),
  };
  const check = validateTemplate(template);
  if (!check.ok) return check;
  if (
    !Number.isInteger(input.reminderDays) ||
    input.reminderDays < MIN_REMINDER_DAYS ||
    input.reminderDays > MAX_REMINDER_DAYS
  ) {
    return { ok: false, message: `Pick a reminder between ${MIN_REMINDER_DAYS} and ${MAX_REMINDER_DAYS} days.` };
  }

  const updated = await db
    .update(reviewSettings)
    .set({
      emailSubject: storedText(template.subject, DEFAULT_TEMPLATE.subject),
      emailBody: storedText(template.body, DEFAULT_TEMPLATE.body),
      reminderBody: storedText(template.reminderBody, DEFAULT_TEMPLATE.reminderBody),
      reminderDays: input.reminderDays,
      remindersEnabled: input.remindersEnabled,
      updatedBy: ctx.userId,
      updatedAt: now,
    })
    .where(eq(reviewSettings.organizationId, ctx.organizationId))
    .returning({ id: reviewSettings.id });
  if (updated.length === 0) return { ok: false, message: "Set up your Google review link first." };

  return { ok: true, message: "Saved. New requests use this wording." };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface ReviewRequestRow {
  publicId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  emailStatus: string | null;
  smsStatus: string | null;
  sentAt: Date | null;
  clickedAt: Date | null;
  clickCount: number;
  reminderDueAt: Date | null;
  remindedAt: Date | null;
  reminderStatus: string | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
}

const PAGE_SIZE = 50;

export async function listReviewRequests(
  db: Database,
  ctx: TenantContext,
  { page = 1 }: { page?: number } = {},
): Promise<{ requests: ReviewRequestRow[]; hasMore: boolean }> {
  const offset = (Math.max(1, Math.floor(page)) - 1) * PAGE_SIZE;
  const rows = await db
    .select({
      publicId: reviewRequests.publicId,
      customerName: reviewRequests.customerName,
      email: reviewRequests.email,
      phone: reviewRequests.phone,
      emailStatus: reviewRequests.emailStatus,
      smsStatus: reviewRequests.smsStatus,
      sentAt: reviewRequests.sentAt,
      clickedAt: reviewRequests.firstClickedAt,
      clickCount: reviewRequests.clickCount,
      reminderDueAt: reviewRequests.reminderDueAt,
      remindedAt: reviewRequests.remindedAt,
      reminderStatus: reviewRequests.reminderStatus,
      unsubscribedAt: reviewRequests.unsubscribedAt,
      createdAt: reviewRequests.createdAt,
    })
    .from(reviewRequests)
    .where(eq(reviewRequests.organizationId, ctx.organizationId))
    .orderBy(desc(reviewRequests.createdAt), desc(reviewRequests.id))
    .limit(PAGE_SIZE + 1)
    .offset(offset);
  return { requests: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

export interface ReviewSummary {
  sent: number;
  clicked: number;
  reminded: number;
  /** Clicked over sent; null until something has been sent, so it never reads as 0%. */
  clickRate: number | null;
}

export async function reviewSummary(db: Database, ctx: TenantContext): Promise<ReviewSummary> {
  const [row] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${reviewRequests.sentAt} is not null)::int`,
      clicked: sql<number>`count(*) filter (where ${reviewRequests.sentAt} is not null and ${reviewRequests.firstClickedAt} is not null)::int`,
      reminded: sql<number>`count(*) filter (where ${reviewRequests.reminderStatus} = 'sent')::int`,
    })
    .from(reviewRequests)
    .where(eq(reviewRequests.organizationId, ctx.organizationId));
  const sent = Number(row?.sent ?? 0);
  const clicked = Number(row?.clicked ?? 0);
  return { sent, clicked, reminded: Number(row?.reminded ?? 0), clickRate: sent > 0 ? clicked / sent : null };
}

export interface ReviewLeadOption {
  publicId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  receivedAt: Date;
}

/**
 * Enquiries to pick a customer from, newest first. Archived ones included:
 * the inbox keeps only its newest few, and a finished job is exactly the kind
 * of enquiry that ends up archived.
 */
export async function listLeadsForReview(db: Database, ctx: TenantContext): Promise<ReviewLeadOption[]> {
  return db
    .select({
      publicId: leads.publicId,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      status: leads.status,
      receivedAt: leads.receivedAt,
    })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
        or(isNotNull(leads.email), isNotNull(leads.phone)),
      ),
    )
    .orderBy(desc(leads.receivedAt), desc(leads.id))
    .limit(50);
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

export interface ReviewSuppression {
  channel: "email" | "sms";
  address: string;
  reason: "unsubscribed" | "sms_opt_out" | "manual";
  createdAt: Date;
}

export async function listReviewSuppressions(db: Database, ctx: TenantContext): Promise<ReviewSuppression[]> {
  const rows = await db
    .select({
      channel: reviewSuppressions.channel,
      address: reviewSuppressions.address,
      reason: reviewSuppressions.reason,
      createdAt: reviewSuppressions.createdAt,
    })
    .from(reviewSuppressions)
    .where(eq(reviewSuppressions.organizationId, ctx.organizationId))
    .orderBy(desc(reviewSuppressions.createdAt));
  return rows as ReviewSuppression[];
}

/** "Don't ask this person": an email address or a phone number. */
export async function addReviewSuppression(db: Database, ctx: TenantContext, raw: string): Promise<ReviewResult> {
  assertMutable(ctx);
  const email = normalizeEmail(raw);
  const phone = email ? null : normalizePhone(raw);
  if (!email && !phone) return { ok: false, message: "Enter an email address or a phone number." };

  await db
    .insert(reviewSuppressions)
    .values({
      organizationId: ctx.organizationId,
      channel: email ? "email" : "sms",
      address: (email ?? phone)!,
      reason: "manual",
      createdBy: ctx.userId,
    })
    .onConflictDoNothing();
  return { ok: true, message: `Added. ${email ?? phone} won't be sent review requests.` };
}

/**
 * Take someone off the list — only someone the business added. A customer who
 * unsubscribed or replied STOP made that choice themselves, and a business
 * quietly reversing it is exactly what the list exists to prevent.
 */
export async function removeReviewSuppression(
  db: Database,
  ctx: TenantContext,
  channel: string,
  address: string,
): Promise<ReviewResult> {
  assertMutable(ctx);
  const removed = await db
    .delete(reviewSuppressions)
    .where(
      and(
        eq(reviewSuppressions.organizationId, ctx.organizationId),
        eq(reviewSuppressions.channel, channel),
        eq(reviewSuppressions.address, address),
        eq(reviewSuppressions.reason, "manual"),
      ),
    )
    .returning({ id: reviewSuppressions.id });
  if (removed.length > 0) return { ok: true, message: `Removed. You can ask ${address} again.` };
  return { ok: false, message: "They asked not to be contacted, so only they can change that." };
}
