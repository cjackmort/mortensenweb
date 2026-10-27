import { getDb } from "@/db/client";
import { findProductImage, imageKindFor } from "@/db/repositories/admin/shop-public";
import { PUBLIC_ID } from "@/lib/shop/public";
import { mediaDriver } from "@/lib/storage/driver";

/**
 * One of a product's photos, as the shop page shows it.
 *
 * Public for the same reason as the feed, and a separate route from the
 * library's own (`/api/media/assets/…`), which stays session-authenticated:
 * this one serves only a photo on a product that is on the site, by its
 * place in that product's list, and nothing a client has not published can
 * be reached through it. `?size=sm|md|lg` picks the derivative; the content
 * type is the one recorded when the derivative was made, never sniffed.
 */

export const dynamic = "force-dynamic";

const SERVEABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const NOT_FOUND = () => new Response(null, { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sitePublicId: string; productPublicId: string; index: string }> },
): Promise<Response> {
  const { sitePublicId, productPublicId, index } = await params;
  if (!PUBLIC_ID.test(sitePublicId) || !PUBLIC_ID.test(productPublicId) || !/^\d{1,2}$/.test(index)) return NOT_FOUND();
  const kind = imageKindFor(new URL(request.url).searchParams.get("size"));
  if (!kind) return NOT_FOUND();

  try {
    const image = await findProductImage(await getDb(), sitePublicId, productPublicId, Number(index), kind);
    if (!image || !SERVEABLE.has(image.contentType)) return NOT_FOUND();

    const stored = await mediaDriver().get(image.storageKey);
    if (!stored) return NOT_FOUND();

    return new Response(Buffer.from(stored.bytes), {
      headers: {
        "content-type": image.contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
        etag: `"${image.storageKey}-${image.byteSize}"`,
        // A minute, like the feed: a photo the client swaps shows within it.
        "netlify-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=300",
        "cache-control": "public, max-age=60",
      },
    });
  } catch (error) {
    console.error("[public:shop-image] read failed", { message: error instanceof Error ? error.message : "unknown" });
    return new Response(null, { status: 503 });
  }
}
