import { getDb } from "@/db/client";
import { findListedEventLogo } from "@/db/repositories/admin/event-bookings";
import { eventLogoDriver } from "@/lib/storage/driver";

/**
 * A listed show's logo, as an image the client's events page can show.
 *
 * Public for the same reason as the feed beside it, and served with every
 * header that keeps an image an image: the content type was sniffed from the
 * bytes when the logo was stored (SVG is never accepted), `nosniff` stops a
 * browser second-guessing it, and the sandboxing CSP means that even a file
 * that somehow got past both could not run anything on the portal's origin.
 *
 * A show taken off the site stops serving its logo too.
 */

export const dynamic = "force-dynamic";

const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sitePublicId: string; eventPublicId: string }> },
): Promise<Response> {
  const { sitePublicId, eventPublicId } = await params;
  if (!PUBLIC_ID.test(sitePublicId) || !PUBLIC_ID.test(eventPublicId)) {
    return new Response(null, { status: 404 });
  }

  try {
    const db = await getDb();
    const logo = await findListedEventLogo(db, sitePublicId, eventPublicId);
    if (!logo) return new Response(null, { status: 404 });

    const stored = await eventLogoDriver().get(logo.key);
    if (!stored) return new Response(null, { status: 404 });

    return new Response(Buffer.from(stored.bytes), {
      headers: {
        "content-type": logo.contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
        // A logo never changes under the same id; an hour at the edge spares
        // Blobs a read per visitor.
        "netlify-cdn-cache-control": "public, s-maxage=3600",
      },
    });
  } catch (error) {
    console.error("[public:event-logo] read failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return new Response(null, { status: 503 });
  }
}
