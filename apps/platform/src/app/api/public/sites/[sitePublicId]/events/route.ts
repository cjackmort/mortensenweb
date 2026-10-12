import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { listUpcomingEvents } from "@/db/repositories/admin/event-bookings";
import { todayIn, type PublicEvent } from "@/lib/growth/bookings";
import { businessTimeZone } from "@/lib/time";

/**
 * A site's upcoming shows, for its events page.
 *
 * Read by visitors' browsers on the client's own website, so it is public
 * (listed in the proxy's PUBLIC_PATHS) and open to any origin: everything in
 * it is something the client chose to publish by approving it, and the site
 * may be on a domain we have not been told about yet.
 *
 * A failure is a 503 with an error body, never an empty list — the page tells
 * "nothing booked yet" and "couldn't load" apart, and must, because one says
 * the stage is free and the other says nothing at all.
 */

export const dynamic = "force-dynamic";

const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * A minute at Netlify's edge. A client who approves a show sees it on their
 * site within a minute, and a busy events page wakes the database once a
 * minute rather than once a visitor.
 */
const CACHING = {
  "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

function portalBase(request: Request): string {
  const configured = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  return configured.startsWith("https://") ? configured.replace(/\/$/, "") : new URL(request.url).origin;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sitePublicId: string }> },
): Promise<Response> {
  const { sitePublicId } = await params;
  if (!PUBLIC_ID.test(sitePublicId)) {
    return NextResponse.json({ error: "Unknown site." }, { status: 404, headers: CORS });
  }

  try {
    const db = await getDb();
    const rows = await listUpcomingEvents(db, sitePublicId, todayIn(businessTimeZone()));
    if (!rows) {
      return NextResponse.json({ error: "Unknown site." }, { status: 404, headers: CORS });
    }

    const base = portalBase(request);
    const events: PublicEvent[] = rows.map((row) => ({
      id: row.publicId,
      actName: row.actName,
      genre: row.genre,
      date: row.eventDate,
      startTime: row.startTime,
      isTicketed: row.isTicketed,
      logoUrl: row.hasLogo
        ? `${base}/api/public/sites/${sitePublicId}/events/${row.publicId}/logo`
        : null,
    }));

    return NextResponse.json({ events }, { headers: { ...CORS, ...CACHING } });
  } catch (error) {
    console.error("[public:events] listing failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "Upcoming events are unavailable right now." },
      { status: 503, headers: CORS },
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
