import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { appointmentBookings, businessProfiles, clients, organizationMemberships, organizations, sites, users } from "@/db/schema";
import { buildClientNotice, buildCustomerEmail } from "@/lib/availability/emails";
import { timeZoneLabel } from "@/lib/availability/format";
import { bookingOriginAllowed, groupByDay, type BookingRequest, type PublicAvailability } from "@/lib/availability/public";
import { findOpenSlot, openSlots } from "@/lib/availability/slots";
import { isIsoDate, type IsoDate } from "@/lib/availability/time";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { isEmailAddress, replySenderAddress } from "@/lib/growth/lead-reply";
import { newPublicId } from "@/lib/ids";
import { siteOrigins } from "@/lib/shop/public";
import type { CalendarDeps } from "../client/availability-calendar";
import { loadSlotInput } from "../client/availability";

/**
 * Booking from a client's website, with no session on either end: the open
 * times a visitor sees, and the booking they make.
 *
 * Only for a site whose client has `booking_enabled`; any other site is
 * "unknown", exactly as one that does not exist, so the feed cannot be used
 * to find out which clients have a site.
 *
 * ## A slot is never read then written
 *
 * The request is checked against the slots as they are now — the rules, the
 * calendar and the bookings — and then inserted with one statement that
 * only writes if nothing held overlaps it, under a unique index on
 * (client, start) for held bookings. Two visitors on the same slot: the
 * database lets one in. See `appointment_bookings_held_slot_key`.
 */

interface BookingSite {
  id: string;
  organizationId: string;
  primaryDomain: string | null;
  productionUrl: string | null;
  netlifySiteName: string | null;
}

async function bookingSite(db: Database, sitePublicId: string): Promise<BookingSite | null> {
  const [site] = await db
    .select({
      id: sites.id,
      organizationId: sites.organizationId,
      primaryDomain: sites.primaryDomain,
      productionUrl: sites.productionUrl,
      netlifySiteName: sites.netlifySiteName,
    })
    .from(sites)
    .innerJoin(clients, eq(clients.organizationId, sites.organizationId))
    .where(
      and(
        eq(sites.publicId, sitePublicId),
        isNull(sites.archivedAt),
        isNull(clients.archivedAt),
        eq(clients.bookingEnabled, true),
      ),
    )
    .limit(1);
  return site ?? null;
}

export type OpenTimes =
  | { ok: true; availability: PublicAvailability }
  | { ok: false; reason: "unknown_site" | "calendar_unavailable"; message: string };

const CALENDAR_DOWN = "Online booking can't check the calendar right now. Please try again shortly, or get in touch directly.";

/** The open times for a site's booking page, by day. `from` and `to` are the business's dates. */
export async function openTimesForSite(
  db: Database,
  sitePublicId: string,
  window: { from?: unknown; to?: unknown } = {},
  deps: CalendarDeps = {},
): Promise<OpenTimes> {
  const site = await bookingSite(db, sitePublicId);
  if (!site) return { ok: false, reason: "unknown_site", message: "Unknown site." };

  const loaded = await loadSlotInput(db, site.organizationId, deps);
  if (loaded.calendar.kind === "failed") {
    return { ok: false, reason: "calendar_unavailable", message: CALENDAR_DOWN };
  }

  const from: IsoDate = isIsoDate(window.from) && window.from > loaded.window.first ? window.from : loaded.window.first;
  const to: IsoDate = isIsoDate(window.to) && window.to < loaded.window.last ? window.to : loaded.window.last;
  const slots = from <= to ? openSlots({ ...loaded.input, from, to }) : [];

  return {
    ok: true,
    availability: {
      timeZone: loaded.rules.timeZone,
      timeZoneLabel: timeZoneLabel(loaded.rules.timeZone, loaded.input.now),
      slotMinutes: loaded.rules.slotMinutes,
      requiresApproval: loaded.rules.requiresApproval,
      open: loaded.open,
      from,
      to,
      days: from <= to ? groupByDay(slots, from, to) : [],
    },
  };
}

export type BookingOutcome =
  | { ok: true; status: "pending" | "confirmed"; bookingId: string; start: string; end: string; timeZone: string }
  | {
      ok: false;
      reason: "unknown_site" | "origin" | "not_open" | "slot_taken" | "calendar_unavailable";
      message: string;
    };

export interface BookingDeps extends CalendarDeps {
  send?: (message: EmailMessage) => Promise<SendResult>;
}

export interface BookingInput {
  sitePublicId: string;
  /** The request's Origin header. */
  origin: string | null;
  request: BookingRequest;
  /** True while the portal runs on a developer's machine: a localhost site may book. */
  portalIsLocal: boolean;
  /** The Availability page, linked from the client's notice. */
  manageUrl: string | null;
}

/** The business's name and address, for a request that arrives without anyone signed in. */
async function businessContact(db: Database, organizationId: string): Promise<{ name: string; email: string | null }> {
  const [org] = await db
    .select({ name: organizations.name, details: businessProfiles.details })
    .from(organizations)
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, organizations.id))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const profileEmail = org?.details?.email?.trim();
  if (isEmailAddress(profileEmail)) return { name: org?.details?.businessName?.trim() || org?.name || "", email: profileEmail };
  const [owner] = await db
    .select({ email: users.email })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(users.status, "active")))
    .orderBy(sql`${organizationMemberships.role} = 'owner' desc`, asc(organizationMemberships.createdAt))
    .limit(1);
  return {
    name: org?.details?.businessName?.trim() || org?.name || "",
    email: isEmailAddress(owner?.email) ? owner.email : null,
  };
}

async function deliver(
  message: EmailMessage | null,
  deps: BookingDeps,
): Promise<{ status: "sent" | "failed" | "not_sent"; error: string | null }> {
  if (!message) return { status: "not_sent", error: null };
  try {
    const result = await (deps.send ?? sendEmail)(message);
    if (result.status === "sent") return { status: "sent", error: null };
    if (result.status === "skipped") return { status: "not_sent", error: null };
    return { status: "failed", error: result.error.slice(0, 500) };
  } catch (error) {
    return { status: "failed", error: (error instanceof Error ? error.message : "unknown").slice(0, 500) };
  }
}

const TAKEN = "Sorry, that time was just taken. Please pick another.";

/**
 * Book a slot. With approval on, it is held as `pending` and the client is
 * asked; with it off, it is `confirmed` and the customer is emailed straight
 * away. Either way the client is told it arrived.
 */
export async function requestBooking(db: Database, input: BookingInput, deps: BookingDeps = {}): Promise<BookingOutcome> {
  const site = await bookingSite(db, input.sitePublicId);
  if (!site) return { ok: false, reason: "unknown_site", message: "Unknown site." };
  if (!bookingOriginAllowed(input.origin, siteOrigins(site), input.portalIsLocal)) {
    return { ok: false, reason: "origin", message: "Bookings are only taken from the business's own website." };
  }

  const loaded = await loadSlotInput(db, site.organizationId, deps);
  if (loaded.calendar.kind === "failed") return { ok: false, reason: "calendar_unavailable", message: CALENDAR_DOWN };
  if (!loaded.open) return { ok: false, reason: "not_open", message: "Online booking isn't open yet." };

  const slot = findOpenSlot(loaded.input, input.request.start);
  if (!slot) return { ok: false, reason: "slot_taken", message: TAKEN };

  const { rules } = loaded;
  const status = rules.requiresApproval ? "pending" : "confirmed";
  const publicId = newPublicId();
  const now = loaded.input.now;
  const bufferMs = rules.bufferMinutes * 60_000;
  const { name, email, phone, note } = input.request;

  // One statement: written only if nothing held overlaps the slot and its
  // buffer, and the unique index refuses a second held booking at the same
  // start even if two of these run at the same instant.
  const inserted = await db.execute(sql`
    INSERT INTO appointment_bookings
      (public_id, organization_id, site_id, starts_at, ends_at, time_zone,
       customer_name, customer_email, customer_phone, note, status, created_at, updated_at)
    SELECT ${publicId}, ${site.organizationId}, ${site.id},
           ${slot.start.toISOString()}::timestamptz, ${slot.end.toISOString()}::timestamptz, ${rules.timeZone},
           ${name}, ${email}, ${phone}, ${note}, ${status},
           ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    WHERE NOT EXISTS (
      SELECT 1 FROM appointment_bookings
      WHERE organization_id = ${site.organizationId}
        AND status IN ('pending', 'confirmed')
        AND starts_at < ${new Date(slot.end.getTime() + bufferMs).toISOString()}::timestamptz
        AND ends_at > ${new Date(slot.start.getTime() - bufferMs).toISOString()}::timestamptz
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const id = (inserted.rows[0] as { id?: string } | undefined)?.id;
  if (!id) return { ok: false, reason: "slot_taken", message: TAKEN };

  await notify(db, site.organizationId, id, { publicId, status, slot, request: input.request, timeZone: rules.timeZone, manageUrl: input.manageUrl }, deps);

  return {
    ok: true,
    status,
    bookingId: publicId,
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    timeZone: rules.timeZone,
  };
}

/** The customer's confirmation (when it is confirmed now) and the client's notice, both recorded. */
async function notify(
  db: Database,
  organizationId: string,
  bookingRowId: string,
  booking: {
    publicId: string;
    status: "pending" | "confirmed";
    slot: { start: Date };
    request: BookingRequest;
    timeZone: string;
    manageUrl: string | null;
  },
  deps: BookingDeps,
): Promise<void> {
  const senderAddress = replySenderAddress();
  const business = await businessContact(db, organizationId);

  const customer =
    booking.status === "confirmed"
      ? await deliver(
          senderAddress && business.email
            ? buildCustomerEmail({
                kind: "confirmed",
                businessName: business.name,
                senderAddress,
                replyTo: business.email,
                to: booking.request.email,
                customerName: booking.request.name,
                start: booking.slot.start,
                timeZone: booking.timeZone,
                bookingId: booking.publicId,
              })
            : null,
          deps,
        )
      : null;

  const client = await deliver(
    senderAddress && business.email
      ? buildClientNotice({
          senderAddress,
          to: business.email,
          businessName: business.name,
          status: booking.status,
          customerName: booking.request.name,
          customerEmail: booking.request.email,
          customerPhone: booking.request.phone,
          note: booking.request.note,
          start: booking.slot.start,
          timeZone: booking.timeZone,
          manageUrl: booking.manageUrl,
          bookingId: booking.publicId,
        })
      : null,
    deps,
  );

  await db
    .update(appointmentBookings)
    .set({
      customerEmailStatus: customer?.status ?? null,
      customerEmailError: customer?.error ?? null,
      clientEmailStatus: client.status,
      updatedAt: new Date(),
    })
    .where(eq(appointmentBookings.id, bookingRowId));
}
