import { and, eq, inArray, isNull, or, isNotNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eventBookings, leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import {
  BOOKING_FIELDS,
  buildBookingApprovedEmail,
  eventsPageUrl,
  fetchUploadedImage,
  isBookingForm,
  isIsoDate,
  parseStartTime,
  readBookingRequest,
  todayIn,
  uploadUrlOf,
  type FetchedImage,
} from "@/lib/growth/bookings";
import { isEmailAddress, replySenderAddress } from "@/lib/growth/lead-reply";
import type { LeadField } from "@/lib/growth/netlify-forms";
import {
  getFormSubmission,
  isNetlifyConfigured,
  type NetlifySubmissionPayload,
} from "@/lib/netlify/api";
import { eventLogoDriver, eventLogoKey } from "@/lib/storage/driver";
import type { StorageDriver } from "@/lib/storage";
import { businessTimeZone } from "@/lib/time";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { replyIdentity } from "./lead-replies";

/**
 * A client's decisions on booking requests, tenant-scoped.
 *
 * Every lookup starts from the lead, filtered by `ctx.organizationId`, so a
 * public id from another tenant is `NotFoundError` exactly as it is in the
 * inbox. The booking row is only ever reached through a lead the caller owns.
 */

export type BookingDecision = "approved" | "declined";

export interface BookingState {
  publicId: string;
  decision: BookingDecision;
  eventDate: string | null;
  startTime: string | null;
  hasLogo: boolean;
  emailStatus: "sent" | "failed" | "not_sent" | null;
  decidedAt: Date;
  /** Approved, then taken off the site. */
  removed: boolean;
}

export type BookingResult = { ok: true; message: string } | { ok: false; message: string };

interface BookingLead {
  id: string;
  publicId: string;
  name: string | null;
  email: string | null;
  formName: string | null;
  fields: LeadField[];
  providerSubmissionId: string;
  siteId: string;
  primaryDomain: string | null;
  productionUrl: string | null;
  netlifySiteName: string | null;
}

async function findBookingLead(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
): Promise<BookingLead> {
  const [row] = await db
    .select({
      id: leads.id,
      publicId: leads.publicId,
      name: leads.name,
      email: leads.email,
      formName: leads.formName,
      fields: leads.fields,
      providerSubmissionId: leads.providerSubmissionId,
      siteId: leads.siteId,
      primaryDomain: sites.primaryDomain,
      productionUrl: sites.productionUrl,
      netlifySiteName: sites.netlifySiteName,
    })
    .from(leads)
    .innerJoin(sites, eq(sites.id, leads.siteId))
    .where(
      and(
        eq(leads.publicId, leadPublicId),
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError();
  return { ...row, fields: Array.isArray(row.fields) ? (row.fields as LeadField[]) : [] };
}

async function existingBooking(db: Database, leadId: string) {
  const [row] = await db
    .select()
    .from(eventBookings)
    .where(eq(eventBookings.leadId, leadId))
    .limit(1);
  return row ?? null;
}

function toState(row: typeof eventBookings.$inferSelect): BookingState {
  return {
    publicId: row.publicId,
    decision: row.decision as BookingDecision,
    eventDate: row.eventDate,
    startTime: row.startTime,
    hasLogo: Boolean(row.logoKey),
    emailStatus: row.emailStatus as BookingState["emailStatus"],
    decidedAt: row.decidedAt,
    removed: row.removedAt !== null,
  };
}

/** What was decided about one lead, or null if nothing yet. */
export async function findBookingState(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
): Promise<BookingState | null> {
  const lead = await findBookingLead(db, ctx, leadPublicId);
  const row = await existingBooking(db, lead.id);
  return row ? toState(row) : null;
}

/** Decisions for a page of the inbox, keyed by lead public id. */
export async function bookingStatesFor(
  db: Database,
  ctx: TenantContext,
  leadPublicIds: string[],
): Promise<Map<string, BookingState>> {
  if (leadPublicIds.length === 0) return new Map();
  const rows = await db
    .select({ leadPublicId: leads.publicId, booking: eventBookings })
    .from(eventBookings)
    .innerJoin(leads, eq(leads.id, eventBookings.leadId))
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        inArray(leads.publicId, leadPublicIds),
      ),
    );
  return new Map(rows.map((row) => [row.leadPublicId, toState(row.booking)]));
}

// ---------------------------------------------------------------------------
// The uploaded logo
// ---------------------------------------------------------------------------

export interface BookingDeps {
  send?: (message: EmailMessage) => Promise<SendResult>;
  now?: Date;
  loadSubmission?: (submissionId: string) => Promise<NetlifySubmissionPayload | null>;
  fetchImage?: (url: string) => Promise<FetchedImage>;
  logos?: StorageDriver;
}

type LogoOutcome =
  | { ok: true; bytes: Uint8Array; contentType: string; extension: string }
  | { ok: false; reason: "none" | "unavailable" | "unusable" };

/**
 * The logo the performer uploaded, fetched fresh from Netlify.
 *
 * Fresh because the link in the stored submission may have expired; through
 * the API because that is the only source that cannot have been edited by
 * whoever filled in the form.
 */
async function fetchRequestLogo(lead: BookingLead, deps: BookingDeps): Promise<LogoOutcome> {
  const request = readBookingRequest(lead.fields);
  if (!request.logoName) return { ok: false, reason: "none" };
  if (!deps.loadSubmission && !isNetlifyConfigured()) return { ok: false, reason: "unavailable" };

  let submission: NetlifySubmissionPayload | null;
  try {
    submission = await (deps.loadSubmission ?? getFormSubmission)(lead.providerSubmissionId);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const data =
    submission?.data && typeof submission.data === "object"
      ? (submission.data as Record<string, unknown>)
      : null;
  const url = data ? uploadUrlOf(data[BOOKING_FIELDS.logo]) : null;
  if (!url) return { ok: false, reason: "unavailable" };

  const fetched = await (deps.fetchImage ?? fetchUploadedImage)(url);
  if (!fetched.ok) return { ok: false, reason: fetched.reason === "unreachable" ? "unavailable" : "unusable" };
  return fetched;
}

/**
 * The logo for the inbox's preview: the stored copy once approved, otherwise
 * straight from Netlify. Null when there is none to show.
 */
export async function readBookingLogo(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  deps: BookingDeps = {},
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const lead = await findBookingLead(db, ctx, leadPublicId);
  if (!isBookingForm(lead.formName)) return null;

  const booking = await existingBooking(db, lead.id);
  if (booking?.logoKey && booking.logoContentType) {
    const stored = await (deps.logos ?? eventLogoDriver()).get(booking.logoKey);
    if (stored) return { bytes: stored.bytes, contentType: booking.logoContentType };
  }

  const fetched = await fetchRequestLogo(lead, deps);
  return fetched.ok ? { bytes: fetched.bytes, contentType: fetched.contentType } : null;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const LOGO_NOTE: Record<"none" | "unavailable" | "unusable", string> = {
  none: "",
  unavailable: " Their logo couldn't be fetched, so the site shows their name instead.",
  unusable: " Their logo wasn't a usable image, so the site shows their name instead.",
};

/**
 * Approve a booking request: put the show on the site, email the performer,
 * and mark the enquiry won.
 *
 * The decision row is claimed before anything is sent, with a conditional
 * write, so two taps on Approve — or two people approving at once — produce
 * one listing and one email. The email is recorded whatever happens to it.
 */
export async function approveBooking(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  input: { eventDate: unknown; startTime: unknown },
  deps: BookingDeps = {},
): Promise<BookingResult> {
  assertMutable(ctx);
  const now = deps.now ?? new Date();

  if (!isIsoDate(input.eventDate)) return { ok: false, message: "Pick the date they'll play." };
  const eventDate = input.eventDate;
  if (eventDate < todayIn(businessTimeZone(), now)) {
    return { ok: false, message: "That date has already passed. Pick the date they'll play." };
  }
  const startTime = parseStartTime(input.startTime);
  if (startTime === undefined) {
    return { ok: false, message: "Use a start time like 9:00 PM, or leave it blank." };
  }

  const lead = await findBookingLead(db, ctx, leadPublicId);
  if (!isBookingForm(lead.formName)) {
    return { ok: false, message: "This enquiry isn't a booking request." };
  }
  const request = readBookingRequest(lead.fields);
  const actName = request.actName ?? lead.name;
  if (!actName) return { ok: false, message: "This request has no act name to put on your site." };

  const existing = await existingBooking(db, lead.id);
  if (existing?.decision === "approved" && existing.removedAt === null) {
    return { ok: false, message: "Already approved — it's on your site." };
  }

  const publicId = existing?.publicId ?? newPublicId();
  const logos = deps.logos ?? eventLogoDriver();

  // A logo already stored from an earlier approval is kept, not fetched again.
  let logoKey = existing?.logoKey ?? null;
  let logoContentType = existing?.logoContentType ?? null;
  let logoNote = "";
  if (!logoKey) {
    const logo = await fetchRequestLogo(lead, deps);
    if (logo.ok) {
      try {
        const key = eventLogoKey(publicId, logo.extension);
        await logos.put({ key, bytes: logo.bytes, contentType: logo.contentType });
        logoKey = key;
        logoContentType = logo.contentType;
      } catch (error) {
        console.error("[bookings] storing a logo failed", {
          message: error instanceof Error ? error.message : "unknown",
        });
        logoNote = LOGO_NOTE.unavailable;
      }
    } else {
      logoNote = LOGO_NOTE[logo.reason];
    }
  }

  const contactEmail = isEmailAddress(lead.email) ? lead.email : null;
  const values = {
    decision: "approved",
    actName: actName.slice(0, 120),
    genre: request.genre,
    eventDate,
    startTime,
    isTicketed: request.sellingTickets === "yes",
    logoKey,
    logoContentType,
    contactEmail,
    decidedBy: ctx.userId,
    decidedAt: now,
    emailStatus: null,
    emailError: null,
    removedAt: null,
    updatedAt: now,
  };

  let claimed: { id: string }[];
  if (existing) {
    // Only from a state that is not already "approved and listed" — the
    // condition is the lock.
    claimed = await db
      .update(eventBookings)
      .set(values)
      .where(
        and(
          eq(eventBookings.id, existing.id),
          or(eq(eventBookings.decision, "declined"), isNotNull(eventBookings.removedAt)),
        ),
      )
      .returning({ id: eventBookings.id });
  } else {
    claimed = await db
      .insert(eventBookings)
      .values({
        ...values,
        publicId,
        organizationId: ctx.organizationId,
        siteId: lead.siteId,
        leadId: lead.id,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: eventBookings.id });
  }
  const bookingId = claimed[0]?.id;
  if (!bookingId) return { ok: false, message: "Already approved — it's on your site." };

  const emailStatus = await emailPerformer(db, ctx, lead, { actName, eventDate, startTime, contactEmail }, deps);
  await db
    .update(eventBookings)
    .set({ emailStatus: emailStatus.status, emailError: emailStatus.error, updatedAt: now })
    .where(eq(eventBookings.id, bookingId));

  await db
    .update(leads)
    .set({ status: "won", statusChangedAt: now, updatedAt: now })
    .where(eq(leads.id, lead.id));

  const told =
    emailStatus.status === "sent"
      ? "They've been emailed"
      : emailStatus.status === "failed"
        ? "The email to them didn't go through — reply to them below"
        : contactEmail
          ? "They weren't emailed (sending isn't set up yet)"
          : "They left no email, so they weren't told — call them";
  return { ok: true, message: `Approved. ${told}, and the show is on your events page.${logoNote}` };
}

async function emailPerformer(
  db: Database,
  ctx: TenantContext,
  lead: BookingLead,
  show: { actName: string; eventDate: string; startTime: string | null; contactEmail: string | null },
  deps: BookingDeps,
): Promise<{ status: "sent" | "failed" | "not_sent"; error: string | null }> {
  if (!show.contactEmail) return { status: "not_sent", error: null };
  const senderAddress = replySenderAddress();
  const identity = await replyIdentity(db, ctx);
  if (!senderAddress || !identity.replyTo) return { status: "not_sent", error: null };

  const message = buildBookingApprovedEmail({
    businessName: identity.businessName,
    senderAddress,
    replyTo: identity.replyTo,
    to: show.contactEmail,
    actName: show.actName,
    eventDate: show.eventDate,
    startTime: show.startTime,
    eventsUrl: eventsPageUrl(lead),
  });

  const result = await (deps.send ?? sendEmail)(message);
  if (result.status === "sent") return { status: "sent", error: null };
  if (result.status === "skipped") return { status: "not_sent", error: null };
  return { status: "failed", error: result.error.slice(0, 500) };
}

/**
 * Decline a booking request. Nobody is emailed — a client who wants to say no
 * kindly has the reply box on the same page. A show already on the site comes
 * off it.
 */
export async function declineBooking(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<BookingResult> {
  assertMutable(ctx);
  const lead = await findBookingLead(db, ctx, leadPublicId);
  if (!isBookingForm(lead.formName)) {
    return { ok: false, message: "This enquiry isn't a booking request." };
  }

  const existing = await existingBooking(db, lead.id);
  if (existing) {
    await db
      .update(eventBookings)
      .set({ decision: "declined", decidedBy: ctx.userId, decidedAt: now, updatedAt: now })
      .where(eq(eventBookings.id, existing.id));
  } else {
    const request = readBookingRequest(lead.fields);
    await db
      .insert(eventBookings)
      .values({
        publicId: newPublicId(),
        organizationId: ctx.organizationId,
        siteId: lead.siteId,
        leadId: lead.id,
        decision: "declined",
        actName: (request.actName ?? lead.name ?? "Unnamed act").slice(0, 120),
        genre: request.genre,
        isTicketed: request.sellingTickets === "yes",
        decidedBy: ctx.userId,
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  await db
    .update(leads)
    .set({ status: "lost", statusChangedAt: now, updatedAt: now })
    .where(eq(leads.id, lead.id));

  return {
    ok: true,
    message: existing?.decision === "approved" ? "Declined, and taken off your events page." : "Declined. They haven't been emailed.",
  };
}

/** Take an approved show off the site, or put it back. Nobody is emailed either way. */
export async function setBookingListed(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  listed: boolean,
  { now = new Date() }: { now?: Date } = {},
): Promise<BookingResult> {
  assertMutable(ctx);
  const lead = await findBookingLead(db, ctx, leadPublicId);
  const existing = await existingBooking(db, lead.id);
  if (!existing || existing.decision !== "approved") {
    return { ok: false, message: "Only an approved show can be listed." };
  }

  await db
    .update(eventBookings)
    .set({ removedAt: listed ? null : now, updatedAt: now })
    .where(eq(eventBookings.id, existing.id));

  return {
    ok: true,
    message: listed ? "Back on your events page." : "Taken off your events page. They haven't been emailed.",
  };
}
