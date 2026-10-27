import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { listShopForSite } from "@/db/repositories/admin/shop-public";
import { PUBLIC_ID } from "@/lib/shop/public";

/**
 * A site's shop, for its shop page: the products the client put on the
 * site, with prices, what is left, image URLs, and how orders are fulfilled.
 *
 * Read by visitors' browsers on the client's own website, so it is public
 * and open to any origin, like the events feed beside it. A failure is a
 * 503 with an error body, never an empty shop: "nothing for sale" and
 * "couldn't load" are different things to a customer.
 */

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/** A minute at the edge: a product put on the site, or sold out, shows within it. */
const CACHING = {
  "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export function portalBase(request: Request): string {
  const configured = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  return configured.startsWith("https://") ? configured.replace(/\/$/, "") : new URL(request.url).origin;
}

export async function GET(request: Request, { params }: { params: Promise<{ sitePublicId: string }> }): Promise<Response> {
  const { sitePublicId } = await params;
  if (!PUBLIC_ID.test(sitePublicId)) {
    return NextResponse.json({ error: "Unknown site." }, { status: 404, headers: CORS });
  }

  try {
    const base = portalBase(request);
    const shop = await listShopForSite(
      await getDb(),
      sitePublicId,
      (productId, index) => `${base}/api/public/sites/${sitePublicId}/shop/products/${productId}/images/${index}`,
    );
    if (!shop) return NextResponse.json({ error: "Unknown site." }, { status: 404, headers: CORS });
    return NextResponse.json(shop, { headers: { ...CORS, ...CACHING } });
  } catch (error) {
    console.error("[public:shop] listing failed", { message: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "The shop is unavailable right now." }, { status: 503, headers: CORS });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
