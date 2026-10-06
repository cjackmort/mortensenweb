import { currentUser } from "@/auth";
import { readThumbnail } from "@/lib/thumbnails";

/**
 * A site's home-page picture, for the admin tiles.
 *
 * Admin only: the tiles are on admin pages, and a picture of a site that has
 * not launched yet is not something to hand to anyone who asks. A missing
 * picture is a plain 404, which the tile's layered background shows as the
 * site's initial.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user || user.role !== "admin") return new Response(null, { status: 404 });

  const { publicId } = await params;
  const found = await readThumbnail(publicId);
  if (!found) return new Response(null, { status: 404 });

  return new Response(Buffer.from(found.bytes), {
    headers: {
      "content-type": "image/jpeg",
      // Private: it sits behind a session. An hour is plenty for a picture
      // that changes once a day.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
