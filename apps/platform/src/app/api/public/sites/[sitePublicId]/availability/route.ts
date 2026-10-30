import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { openTimesForSite } from "@/db/repositories/admin/availability-public";
import { PUBLIC_ID } from "@/lib/shop/public";

/**
 * A booking site's open times, for its book page: every date in the window
 * with the slots still free, in the business's timezone.
 *
 * Read by visitors' browsers on the client's own website, so it is public
 * and open to any origin like the shop and events feeds beside it: open
 * times are what the business wants anyone to see, and the site may be on a
 * domain we have not been told about yet. Making a booking is the guarded
 * step (`../bookings`).
 *
 * A calendar that cannot be read is a 503, never an empty week: "fully
 * booked" and "can't check right now" tell a customer different things.
 */

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * Brief at the edge: a slot booked a moment ago should disappear quickly,
 * and the booking itself is re-checked anyway. The calendar read behind it
 * is cached for minutes, so this mostly spares the database a busy page.
 */
const CACHING = {
  "Netlify-CDN-Cache-Control": "public, s-maxage=15, stale-while-revalidate=45",
};

export async function GET(request: Request, { params }: { params: Promise<{ sitePublicId: string }> }): Promise<Response> {
  const { sitePublicId } = await params;
  if (!PUBLIC_ID.test(sitePublicId)) {
    return NextResponse.json({ error: "Unknown site." }, { status: 404, headers: CORS });
  }

  const url = new URL(request.url);
  try {
    const result = await openTimesForSite(await getDb(), sitePublicId, {
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    if (!result.ok) {
      const status = result.reason === "unknown_site" ? 404 : 503;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status, headers: CORS });
    }
    return NextResponse.json(result.availability, { headers: { ...CORS, ...CACHING } });
  } catch (error) {
    console.error("[public:availability] listing failed", {
      site: sitePublicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Booking times are unavailable right now." }, { status: 503, headers: CORS });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
