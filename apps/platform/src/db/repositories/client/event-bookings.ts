import { and, asc, eq, gte, inArray, isNull, lte, ne, or, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eventBookings, leads, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import {
  BOOKING_FIELDS,
  buildBookingApprovedEmail,
  eventsPageUrl,
  BOOKING_FORM_NAMES,
  fetchUploadedImage,
  formatShowDate,
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
import { monthBounds } from "@/lib/growth/booking-calendar";
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

/** `held`: on the client's calendar while they agree it with the band — not on the site, nobody emailed. */
export type BookingDecision = "held" | "approved" | "declined";

export interface BookingState {
  publicId: string;
  decision: BookingDecision;
  actName: string;
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
    actName: row.actName,
    eventDate: row.eventDate,
    startTime: row.startTime,
    hasLogo: Boolean(row.logoKey),
    emailStatus: row.emailStatus as BookingState["emailStatus"],
    decidedAt: row.decidedAt,
    removed: row.removedAt !== null,
  };
}

/**
 * The lead's side of a decision.
 *
 * Deciding counts as reading it: a request approved straight from the inbox
 * list was never opened, and would otherwise stay in the Growth tab's unread
 * count. A time it was already read is kept.
 *
 * An archived request stays archived, and still records the outcome: the
 * inbox holds the newest ten, and a decision on an older one must not push a
 * newer one out of it, nor go uncounted because it was decided late.
 */
async function markLeadDecided(
  db: Database,
  leadId: string,
  status: "contacted" | "won" | "lost",
  now: Date,
): Promise<void> {
  await db
    .update(leads)
    .set({ readAt: sql`coalesce(${leads.readAt}, ${now})`, status, statusChangedAt: now, updatedAt: now })
    .where(eq(leads.id, leadId));
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

type When = { ok: true; eventDate: string; startTime: string | null } | { ok: false; message: string };

/** The date and optional start time from a form, checked: a real date, not already past. */
function readWhen(input: { eventDate: unknown; startTime: unknown }, now: Date): When {
  if (!isIsoDate(input.eventDate)) return { ok: false, message: "Pick the date they'll play." };
  if (input.eventDate < todayIn(businessTimeZone(), now)) {
    return { ok: false, message: "That date has already passed. Pick the date they'll play." };
  }
  const startTime = parseStartTime(input.startTime);
  if (startTime === undefined) {
    return { ok: false, message: "Use a start time like 9:00 PM, or leave it blank." };
  }
  return { ok: true, eventDate: input.eventDate, startTime };
}

/**
 * Hold a date: save the date and time agreed with the band to the client's
 * calendar, before approving. Nothing goes on the site and nobody is emailed —
 * that is what Approve is for, and it uses the held date and time.
 *
 * A show already on the site is not moved from here: moving it would take it
 * off the site without the band being told. Taking it off first makes that
 * the client's explicit choice.
 */
export async function holdBooking(
  db: Database,
  ctx: TenantContext,
  leadPublicId: string,
  input: { eventDate: unknown; startTime: unknown },
  { now = new Date() }: { now?: Date } = {},
): Promise<BookingResult> {
  assertMutable(ctx);
  const when = readWhen(input, now);
  if (!when.ok) return when;

  const lead = await findBookingLead(db, ctx, leadPublicId);
  if (!isBookingForm(lead.formName)) {
    return { ok: false, message: "This enquiry isn't a booking request." };
  }
  const request = readBookingRequest(lead.fields);
  const actName = (request.actName ?? lead.name ?? "Unnamed act").slice(0, 120);

  const values = {
    decision: "held",
    actName,
    genre: request.genre,
    eventDate: when.eventDate,
    startTime: when.startTime,
    isTicketed: request.sellingTickets === "yes",
    decidedBy: ctx.userId,
    decidedAt: now,
    emailStatus: null,
    emailError: null,
    removedAt: null,
    updatedAt: now,
  };

  const existing = await existingBooking(db, lead.id);
  const saved = existing
    ? await db
        .update(eventBookings)
        .set(values)
        .where(
          and(
            eq(eventBookings.id, existing.id),
            or(ne(eventBookings.decision, "approved"), isNotNull(eventBookings.removedAt)),
          ),
        )
        .returning({ id: eventBookings.id })
    : await db
        .insert(eventBookings)
        .values({
          ...values,
          publicId: newPublicId(),
          organizationId: ctx.organizationId,
          siteId: lead.siteId,
          leadId: lead.id,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: eventBookings.id });
  if (saved.length === 0) {
    return { ok: false, message: "It's already on your site. Take it off the site first to move it." };
  }

  await markLeadDecided(db, lead.id, "contacted", now);
  return {
    ok: true,
    message: `Saved to your calendar for ${formatShowDate(when.eventDate, when.startTime)}. It isn't on your site yet, and they haven't been emailed.`,
  };
}

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

  const when = readWhen(input, now);
  if (!when.ok) return when;
  const { eventDate, startTime } = when;

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
    // Only from a state that is not already "approved and listed" — held,
    // declined, or taken off the site. The condition is the lock.
    claimed = await db
      .update(eventBookings)
      .set(values)
      .where(
        and(
          eq(eventBookings.id, existing.id),
          or(ne(eventBookings.decision, "approved"), isNotNull(eventBookings.removedAt)),
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

  await markLeadDecided(db, lead.id, "won", now);

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

  await markLeadDecided(db, lead.id, "lost", now);

  const message =
    existing?.decision === "approved" && existing.removedAt === null
      ? "Declined, and taken off your events page."
      : existing?.decision === "held"
        ? "Declined, and taken off your calendar. They haven't been emailed."
        : "Declined. They haven't been emailed.";
  return { ok: true, message };
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

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

export type CalendarKind = "booked" | "held" | "requested";

export interface CalendarEntry {
  date: string;
  kind: CalendarKind;
  actName: string;
  startTime: string | null;
  /** The request to open from the calendar; null once its enquiry was deleted. */
  leadPublicId: string | null;
}

const KIND_ORDER: Record<CalendarKind, number> = { booked: 0, held: 1, requested: 2 };

/**
 * Whether this client takes bookings — any booking request has ever arrived.
 * Only they get the calendar; a plumber's inbox has no use for one.
 */
export async function takesBookings(db: Database, ctx: TenantContext): Promise<boolean> {
  const [row] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.organizationId, ctx.organizationId), inArray(leads.formName, [...BOOKING_FORM_NAMES])))
    .limit(1);
  return Boolean(row);
}

/**
 * How long before a night a band might ask for it. Bounds the scan for
 * undecided requests, whose date lives inside the submitted fields.
 */
const REQUEST_LOOKBACK_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One month of the client's bookings: shows on the site, dates held while
 * they talk to the band, and nights bands have asked for that nobody has
 * answered yet — including requests that have since been archived out of the
 * inbox, so a request is never lost from both places at once.
 *
 * Declined requests, shows taken off the site, and requests for nights that
 * have passed are not on it.
 */
export async function bookingCalendar(
  db: Database,
  ctx: TenantContext,
  month: string,
  { today = todayIn(businessTimeZone()) }: { today?: string } = {},
): Promise<CalendarEntry[]> {
  const { first, last } = monthBounds(month);

  const decided = await db
    .select({
      decision: eventBookings.decision,
      eventDate: eventBookings.eventDate,
      startTime: eventBookings.startTime,
      actName: eventBookings.actName,
      leadPublicId: leads.publicId,
      leadDeletedAt: leads.deletedAt,
    })
    .from(eventBookings)
    .leftJoin(leads, eq(leads.id, eventBookings.leadId))
    .where(
      and(
        eq(eventBookings.organizationId, ctx.organizationId),
        or(
          eq(eventBookings.decision, "held"),
          and(eq(eventBookings.decision, "approved"), isNull(eventBookings.removedAt)),
        ),
        gte(eventBookings.eventDate, first),
        lte(eventBookings.eventDate, last),
      ),
    );

  const undecided = await db
    .select({ publicId: leads.publicId, name: leads.name, fields: leads.fields })
    .from(leads)
    .leftJoin(eventBookings, eq(eventBookings.leadId, leads.id))
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
        inArray(leads.formName, [...BOOKING_FORM_NAMES]),
        isNull(eventBookings.id),
        gte(leads.receivedAt, new Date(Date.parse(first) - REQUEST_LOOKBACK_DAYS * DAY_MS)),
        lte(leads.receivedAt, new Date(Date.parse(last) + DAY_MS)),
      ),
    )
    .orderBy(asc(leads.receivedAt));

  const entries: CalendarEntry[] = decided.map((row) => ({
    date: row.eventDate!,
    kind: row.decision === "held" ? "held" : "booked",
    actName: row.actName,
    startTime: row.startTime,
    leadPublicId: row.leadDeletedAt ? null : row.leadPublicId,
  }));
  for (const row of undecided) {
    const fields = Array.isArray(row.fields) ? (row.fields as LeadField[]) : [];
    const request = readBookingRequest(fields);
    if (!request.requestedDate || request.requestedDate < first || request.requestedDate > last) continue;
    // A night that passed without an answer is no longer a question.
    if (request.requestedDate < today) continue;
    entries.push({
      date: request.requestedDate,
      kind: "requested",
      actName: request.actName ?? row.name ?? "Unnamed act",
      startTime: null,
      leadPublicId: row.publicId,
    });
  }

  return entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99") ||
      a.actName.localeCompare(b.actName),
  );
}
