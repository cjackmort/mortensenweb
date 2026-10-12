import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireGrowthFeature } from "@/db/repositories/client/growth";
import { readBookingLogo } from "@/db/repositories/client/event-bookings";

/**
 * The logo a performer uploaded with a booking request, for the client to see
 * before deciding.
 *
 * Behind the session and scoped to the client's own leads, like the page that
 * shows it. The bytes were checked to be a raster image before they reach
 * here, and are served with `nosniff` and a sandboxing CSP regardless: this is
 * a stranger's upload on the portal's own origin.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user?.organizationId) return new Response(null, { status: 404 });

  const { publicId } = await params;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireGrowthFeature(db, ctx, "leads"))) return new Response(null, { status: 404 });

  let logo;
  try {
    logo = await readBookingLogo(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) return new Response(null, { status: 404 });
    console.error("[bookings] logo preview failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return new Response(null, { status: 503 });
  }
  if (!logo) return new Response(null, { status: 404 });

  return new Response(Buffer.from(logo.bytes), {
    headers: {
      "content-type": logo.contentType,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
