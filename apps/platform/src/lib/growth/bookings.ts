import type { EmailMessage } from "@/lib/email/mailer";
import { ALLOWED_IMAGE_TYPES } from "@/lib/storage";
import type { LeadField } from "./netlify-forms";
import { fromHeader } from "./lead-reply";

/**
 * Event bookings: performers asking to play at a client's venue, and the
 * client saying yes or no from the leads inbox.
 *
 * A request is an ordinary Netlify form submission, so it reaches the portal
 * through the same webhook as every contact form and lands in the same inbox.
 * What makes it a *booking* is the form's name. A site that wants this names
 * its form `event-booking` and uses the field names below; nothing has to be
 * switched on per site.
 *
 * Approved bookings are published by the portal itself, as a JSON feed the
 * site's events page reads (`/api/public/sites/<site>/events`). The site is
 * never rebuilt for a booking: approving one is a click, and a click should
 * not wait on a deploy.
 *
 * This module is the pure part — reading a request, checking a date, fetching
 * an upload safely, writing the email. The decisions themselves are in
 * `db/repositories/client/event-bookings.ts`.
 */

export const BOOKING_FORM_NAMES: ReadonlySet<string> = new Set(["event-booking"]);

export function isBookingForm(formName: string | null | undefined): boolean {
  return typeof formName === "string" && BOOKING_FORM_NAMES.has(formName);
}

/**
 * The `name` attributes the booking form must use. The site's CLAUDE.md lists
 * the same names under "never rename".
 */
export const BOOKING_FIELDS = {
  actName: "act_name",
  genre: "genre",
  date: "preferred_date",
  attendance: "expected_attendance",
  tickets: "selling_tickets",
  logo: "logo",
  links: "links",
} as const;

/** Where a booking site lists its upcoming shows. Linked from the approval email. */
export const EVENTS_PAGE_PATH = "/events";

export type TicketAnswer = "yes" | "no" | "unsure";

export interface BookingRequest {
  actName: string | null;
  genre: string | null;
  /** `YYYY-MM-DD`, or null when missing or not a real date. */
  requestedDate: string | null;
  expectedAttendance: string | null;
  sellingTickets: TicketAnswer | null;
  /** The uploaded logo's filename, when one came with the request. */
  logoName: string | null;
  links: string | null;
}

function field(fields: LeadField[], key: string): string | null {
  const found = fields.find((f) => f.key === key);
  const value = found?.value.trim();
  return value ? value : null;
}

function ticketAnswer(value: string | null): TicketAnswer | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.startsWith("yes")) return "yes";
  if (v.startsWith("no") && !v.startsWith("not")) return "no";
  return "unsure";
}

/** What the performer asked for, read from a booking lead's fields by name. */
export function readBookingRequest(fields: LeadField[]): BookingRequest {
  const date = field(fields, BOOKING_FIELDS.date);
  return {
    actName: field(fields, BOOKING_FIELDS.actName)?.slice(0, 120) ?? null,
    genre: field(fields, BOOKING_FIELDS.genre)?.slice(0, 80) ?? null,
    requestedDate: date && isIsoDate(date) ? date : null,
    expectedAttendance: field(fields, BOOKING_FIELDS.attendance),
    sellingTickets: ticketAnswer(field(fields, BOOKING_FIELDS.tickets)),
    logoName: field(fields, BOOKING_FIELDS.logo),
    links: field(fields, BOOKING_FIELDS.links),
  };
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/** A real calendar date in `YYYY-MM-DD` form. `2026-02-30` is not one. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * A start time from the approval form: `HH:MM`, 24-hour, or blank.
 * Returns `undefined` for anything else, so "blank" and "nonsense" differ.
 */
export function parseStartTime(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : undefined;
}

/** Today's date where the business is, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone });
}

/**
 * `Saturday, November 14, 2026`.
 *
 * Formatted in UTC on purpose: an event date is a calendar day, not an
 * instant, and converting midnight UTC into Denver time would print the day
 * before.
 */
export function formatEventDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `21:00` → `9 PM`, `21:30` → `9:30 PM`. */
export function formatStartTime(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** `Saturday, November 14, 2026 · 9 PM`, or just the day when no time was set. */
export function formatShowDate(eventDate: string, startTime: string | null): string {
  const day = formatEventDate(eventDate);
  return startTime ? `${day} · ${formatStartTime(startTime)}` : day;
}

export interface DecisionSummary {
  decision: "held" | "approved" | "declined";
  actName: string;
  eventDate: string | null;
  startTime: string | null;
  emailStatus: "sent" | "failed" | "not_sent" | null;
  /** Approved, then taken off the site. */
  removed?: boolean;
}

/**
 * One sentence for the inbox after a quick Approve or Decline.
 *
 * The row leaves the Open list the moment it is decided, and its buttons and
 * their result go with it — so this is read back from the stored decision,
 * and in particular never says "emailed" when the send failed.
 */
export function decisionNotice(state: DecisionSummary): string {
  if (state.decision === "declined") {
    return `You declined ${state.actName}. They haven't been emailed.`;
  }
  const when = state.eventDate ? ` for ${formatShowDate(state.eventDate, state.startTime)}` : "";
  if (state.decision === "held") {
    return `${state.actName} is held on your calendar${when}. It isn't on your site yet.`;
  }
  if (state.removed) {
    return `${state.actName} was approved${when}, then taken off your events page.`;
  }
  const booked = `${state.actName} is booked${when}`;
  if (state.emailStatus === "sent") {
    return `${booked}. They were emailed, and the show is on your events page.`;
  }
  if (state.emailStatus === "failed") {
    return `${booked} and is on your events page, but the email to them didn't go through. Open the request to reply to them.`;
  }
  return `${booked} and is on your events page. They weren't emailed.`;
}

// ---------------------------------------------------------------------------
// The uploaded logo
// ---------------------------------------------------------------------------

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/**
 * Hosts an uploaded file may be fetched from.
 *
 * The link comes out of a form submission, and a visitor controls what they
 * submit: a text value posted under the logo's field name arrives looking just
 * like a link. Fetching whatever it says would let a stranger make the portal
 * request any address it can reach. So the portal only fetches from where
 * Netlify keeps uploads, over https, and checks again at every redirect.
 */
const UPLOAD_HOST_SUFFIXES = [
  ".amazonaws.com",
  ".cloudfront.net",
  ".netlify.app",
  ".netlify.com",
  ".netlifyusercontent.com",
];

export function isAllowedUploadUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return UPLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The link to an uploaded file in a submission's `data`, if it is one we may fetch. */
export function uploadUrlOf(value: unknown): string | null {
  const url =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string"
        ? (value as { url: string }).url
        : null;
  return url && isAllowedUploadUrl(url) ? url : null;
}

export type FetchedImage =
  | { ok: true; bytes: Uint8Array; contentType: string; extension: string }
  | { ok: false; reason: "unreachable" | "too_large" | "not_an_image" };

/** The image type the bytes actually are, from the same allowlist as uploads. SVG never. */
export function sniffImage(bytes: Uint8Array): { contentType: string; extension: string } | null {
  for (const [contentType, { extension, magic }] of ALLOWED_IMAGE_TYPES) {
    const matches = magic.some((signature) => signature.every((byte, i) => bytes[i] === byte));
    if (!matches) continue;
    if (contentType === "image/webp" && !(bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)) {
      continue;
    }
    return { contentType, extension };
  }
  return null;
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Download an uploaded image: allowed hosts only, redirects followed by hand
 * so each hop is checked, a size cap enforced while reading, and the type
 * decided by the bytes rather than by any header.
 */
export async function fetchUploadedImage(
  url: string,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<FetchedImage> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedUploadUrl(current)) return { ok: false, reason: "unreachable" };

    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "unreachable" };
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) return { ok: false, reason: "unreachable" };

    const bytes = await readCapped(response, MAX_LOGO_BYTES);
    if (!bytes) return { ok: false, reason: "too_large" };
    const type = sniffImage(bytes);
    if (!type) return { ok: false, reason: "not_an_image" };
    return { ok: true, bytes, ...type };
  }
  return { ok: false, reason: "unreachable" };
}

// ---------------------------------------------------------------------------
// The "you're booked" email
// ---------------------------------------------------------------------------

/**
 * `https://venue.example/events`, from the site's own address — never from
 * the submission. The custom domain once there is one, else the live URL,
 * else the Netlify address the site is served at before launch.
 */
export function eventsPageUrl(site: {
  primaryDomain: string | null;
  productionUrl: string | null;
  netlifySiteName?: string | null;
}): string | null {
  const domain = site.primaryDomain?.trim().toLowerCase();
  if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return `https://${domain}${EVENTS_PAGE_PATH}`;
  if (site.productionUrl) {
    try {
      const url = new URL(site.productionUrl);
      if (url.protocol === "https:") return `${url.origin}${EVENTS_PAGE_PATH}`;
    } catch {
      // Not a URL; no link is better than a broken one.
    }
  }
  const name = site.netlifySiteName?.trim().toLowerCase();
  // Netlify site names are DNS labels.
  if (name && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return `https://${name}.netlify.app${EVENTS_PAGE_PATH}`;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface BookingApprovedInput {
  businessName: string;
  senderAddress: string;
  /** The business's own address: the performer's answer goes there. */
  replyTo: string;
  to: string;
  actName: string;
  eventDate: string;
  startTime: string | null;
  eventsUrl: string | null;
}

/**
 * Sent the moment a client approves. Same envelope as a lead reply — the
 * business's name, our verified address, the business as Reply-To and Bcc —
 * so the performer can answer straight back and the client keeps a copy.
 */
export function buildBookingApprovedEmail(input: BookingApprovedInput): EmailMessage {
  const business = oneLine(input.businessName, 60) || "The venue";
  const act = oneLine(input.actName, 120);
  const when = formatEventDate(input.eventDate);
  const at = input.startTime ? ` at ${formatStartTime(input.startTime)}` : "";

  const lines = [
    `Good news: ${business} has picked ${act} to perform on ${when}${at}.`,
    "",
    input.eventsUrl
      ? `You're on the upcoming events page now: ${input.eventsUrl}`
      : "You'll be listed with the upcoming events on our website.",
    "",
    "Reply to this email with any questions about the night — load-in, set times, gear — and it comes straight to us.",
    "",
    business,
  ];

  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;font-size:15px;line-height:1.55">
<div style="max-width:600px;padding:16px">
<p style="margin:0 0 14px">Good news: <strong>${escapeHtml(business)}</strong> has picked <strong>${escapeHtml(act)}</strong> to perform on <strong>${escapeHtml(when)}${escapeHtml(at)}</strong>.</p>
<p style="margin:0 0 14px">${
    input.eventsUrl
      ? `You&rsquo;re on the upcoming events page now: <a href="${escapeHtml(input.eventsUrl)}">${escapeHtml(input.eventsUrl)}</a>`
      : "You&rsquo;ll be listed with the upcoming events on our website."
  }</p>
<p style="margin:0 0 14px">Reply to this email with any questions about the night &mdash; load-in, set times, gear &mdash; and it comes straight to us.</p>
<p style="margin:0">${escapeHtml(business)}</p>
</div></body></html>`;

  return {
    to: input.to,
    from: fromHeader(business, input.senderAddress),
    replyTo: input.replyTo,
    bcc: input.replyTo,
    subject: `You're booked: ${oneLine(act, 60)} at ${business}, ${when}`,
    text: lines.join("\n"),
    html,
  };
}

// ---------------------------------------------------------------------------
// The public feed
// ---------------------------------------------------------------------------

/** One upcoming show, as the site's events page receives it. Nothing private. */
export interface PublicEvent {
  id: string;
  actName: string;
  genre: string | null;
  date: string;
  startTime: string | null;
  isTicketed: boolean;
  logoUrl: string | null;
}
