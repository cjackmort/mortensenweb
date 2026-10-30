import { z } from "zod";
import type { Slot } from "./slots";
import { addDays, type IsoDate } from "./time";

/**
 * Booking as a client's website sees it: the feed of open times, the shape
 * of a booking request, and which pages may send one. Pure, so the routes
 * and the tests share one reading.
 */

/**
 * A field real people never see or fill in. The site's form renders it
 * off-screen; a script that fills every input fills this one too, and its
 * request is answered as if it worked and then dropped.
 */
export const HONEYPOT_FIELD = "company";

/** A request names one slot and the person; nothing near this size is honest. */
export const MAX_BOOKING_BODY_BYTES = 4 * 1024;

export interface PublicSlot {
  start: string;
  end: string;
}

export interface PublicDay {
  date: IsoDate;
  slots: PublicSlot[];
}

export interface PublicAvailability {
  timeZone: string;
  /** `Mountain Time`: what the page says the times are in. */
  timeZoneLabel: string;
  slotMinutes: number;
  /** True: a booking is a request until the business approves it. */
  requiresApproval: boolean;
  /** False until the business has set any hours: the page says booking is not open yet. */
  open: boolean;
  from: IsoDate;
  to: IsoDate;
  /** Every date in the window, in order, empty where nothing is open. */
  days: PublicDay[];
}

/** Every date from `from` to `to`, each with its slots. */
export function groupByDay(slots: readonly Slot[], from: IsoDate, to: IsoDate): PublicDay[] {
  const days: PublicDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    days.push({
      date,
      slots: slots.filter((s) => s.date === date).map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    });
  }
  return days;
}

const PHONE = /^[0-9+().\-\s]{7,40}$/;

const requestSchema = z.object({
  start: z.iso.datetime({ offset: true, message: "Pick a time." }),
  name: z.string().trim().min(1, "Tell us your name.").max(120, "Keep your name under 120 characters."),
  email: z.string().trim().max(254).pipe(z.email("Check your email address.")),
  phone: z
    .string()
    .trim()
    .max(40)
    .refine((v) => v === "" || PHONE.test(v), "Check your phone number.")
    .optional(),
  note: z.string().trim().max(1000, "Keep the note under 1,000 characters.").optional(),
  [HONEYPOT_FIELD]: z.string().max(500).optional(),
});

export interface BookingRequest {
  start: Date;
  name: string;
  email: string;
  phone: string | null;
  note: string | null;
}

export type ParsedBookingRequest =
  | { ok: true; request: BookingRequest }
  | { ok: false; message: string }
  /** The honeypot was filled: answer as if it worked, keep nothing. */
  | { ok: "bot" };

/** Read a booking body without trusting any of it. */
export function parseBookingRequest(body: unknown): ParsedBookingRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Send a time, your name and your email." };
  }
  const trap = (body as Record<string, unknown>)[HONEYPOT_FIELD];
  if (typeof trap === "string" && trap.trim() !== "") return { ok: "bot" };

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  const { start, name, email, phone, note } = parsed.data;
  return {
    ok: true,
    request: {
      start: new Date(start),
      name: name.replace(/[\r\n\t]+/g, " "),
      email: email.toLowerCase(),
      phone: phone ? phone : null,
      note: note ? note : null,
    },
  };
}

/**
 * Whether a booking may come from this browser page.
 *
 * A booking holds part of someone's day and sends email, so it is taken only
 * from the site's own addresses — another website cannot fill a client's
 * diary from its visitors' browsers. A request with no Origin header is not
 * from a browser page and gains nothing from the check, so it is let through
 * to the same rate limits as everyone. While the portal itself runs on a
 * developer's machine, a site on localhost may book too.
 */
export function bookingOriginAllowed(origin: string | null, siteOrigins: readonly string[], portalIsLocal: boolean): boolean {
  if (!origin) return true;
  if (siteOrigins.includes(origin)) return true;
  if (!portalIsLocal) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** The site's own booking page addresses, for the client to see where bookings come from. */
export const BOOK_PAGE_PATH = "/book";
