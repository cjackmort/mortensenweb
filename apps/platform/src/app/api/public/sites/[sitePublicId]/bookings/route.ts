import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requestBooking } from "@/db/repositories/admin/availability-public";
import { ipFromHeaders } from "@/lib/auth/client-ip";
import { MAX_BOOKING_BODY_BYTES, parseBookingRequest } from "@/lib/availability/public";
import { createRateLimiter } from "@/lib/reviews/rate-limit";
import { PUBLIC_ID } from "@/lib/shop/public";

/**
 * "Book": a visitor on the client's site takes an open time.
 *
 * Public, because the visitor is on the client's domain and holds nothing.
 * What it accepts is a start time and who they are, read with a schema; the
 * slot's length, its status (pending or confirmed) and who is emailed are
 * decided here from what the client set up. The slot is re-checked against
 * the rules, the calendar and the bookings as they are now, and written by
 * one statement the database refuses to double-book.
 *
 * Guarded in layers, cheapest first: a hidden field only scripts fill in,
 * a limit per address and one per site (the address can be forged; the
 * site's limit cannot), a size cap, and the page's Origin, which must be one
 * of the site's own addresses — another website cannot fill a client's
 * diary from its visitors' browsers.
 */

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** A person books once or twice; a few retries after "just taken" is the honest ceiling. */
const perAddress = createRateLimiter({ limit: 6, windowMs: 10 * 60_000 });
/** More than a small business takes in an hour, fewer than a script would send. */
const perSite = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });

const STATUS: Record<string, number> = {
  unknown_site: 404,
  origin: 403,
  not_open: 409,
  slot_taken: 409,
  calendar_unavailable: 503,
};

function portalBase(request: Request): string {
  const configured = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  return configured.startsWith("https://") ? configured.replace(/\/$/, "") : new URL(request.url).origin;
}

/** The portal on a developer's machine: a site on localhost may book against it. */
function portalIsLocal(request: Request): boolean {
  if ((process.env.AUTH_URL ?? "").startsWith("https://")) return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

const TOO_MANY = "Too many bookings just now. Please wait a few minutes, or get in touch directly.";

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: CORS });

export async function POST(request: Request, { params }: { params: Promise<{ sitePublicId: string }> }): Promise<Response> {
  const { sitePublicId } = await params;
  if (!PUBLIC_ID.test(sitePublicId)) return json({ error: "Unknown site." }, 404);

  const ip = ipFromHeaders(request.headers);
  if (ip && !perAddress.allow(ip)) return json({ error: TOO_MANY }, 429);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BOOKING_BODY_BYTES) return json({ error: "Request too large." }, 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BOOKING_BODY_BYTES) return json({ error: "Request too large." }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "Send JSON with a start time, your name and your email." }, 400);
  }

  const parsed = parseBookingRequest(body);
  // Answered like a request that worked, so a script learns nothing; nothing is kept.
  if (parsed.ok === "bot") return json({ status: "pending" }, 202);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  // Counted only for well-formed requests, so junk cannot use up a site's hour.
  if (!perSite.allow(sitePublicId)) return json({ error: TOO_MANY }, 429);

  try {
    const outcome = await requestBooking(await getDb(), {
      sitePublicId,
      origin: request.headers.get("origin"),
      request: parsed.request,
      portalIsLocal: portalIsLocal(request),
      manageUrl: `${portalBase(request)}/dashboard/availability`,
    });
    if (!outcome.ok) return json({ error: outcome.message, reason: outcome.reason }, STATUS[outcome.reason] ?? 400);
    return json(
      { status: outcome.status, booking: outcome.bookingId, start: outcome.start, end: outcome.end, timeZone: outcome.timeZone },
      201,
    );
  } catch (error) {
    console.error("[public:bookings] failed", {
      site: sitePublicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return json({ error: "Booking is unavailable right now. Please try again shortly." }, 503);
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
