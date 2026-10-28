import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { beginShopCheckout } from "@/db/repositories/admin/shop-checkout";
import { ipFromHeaders } from "@/lib/auth/client-ip";
import { createRateLimiter } from "@/lib/reviews/rate-limit";
import { parseCheckoutRequest, PUBLIC_ID } from "@/lib/shop/public";

/**
 * "Buy": a visitor on the client's site asks for a Stripe Checkout page.
 *
 * Public, from any origin, because the visitor is on the client's domain and
 * holds nothing. What it accepts from the browser is a product id and a
 * quantity; the price, the currency, the account the money goes to and the
 * page the buyer comes back to are all decided here from what the client
 * set up. The one thing a page can influence is which of the site's own
 * pages the buyer returns to.
 *
 * Rate-limited per address: each call holds a unit for half an hour, so a
 * script could otherwise empty a shelf without paying for anything.
 */

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const MAX_BODY_BYTES = 4 * 1024;
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

const STATUS: Record<string, number> = {
  unknown_site: 404,
  unknown_product: 404,
  not_open: 409,
  no_return: 409,
  sold_out: 409,
  stripe_failed: 503,
};

function portalBase(request: Request): string | null {
  const configured = process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  if (configured.startsWith("https://")) return configured.replace(/\/$/, "");
  const origin = new URL(request.url).origin;
  // Stripe will only show images it can fetch over https.
  return origin.startsWith("https://") ? origin : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ sitePublicId: string }> }): Promise<Response> {
  const { sitePublicId } = await params;
  if (!PUBLIC_ID.test(sitePublicId)) return NextResponse.json({ error: "Unknown site." }, { status: 404, headers: CORS });

  const ip = ipFromHeaders(request.headers);
  if (ip && !limiter.allow(ip)) {
    return NextResponse.json({ error: "Too many attempts. Please wait a minute." }, { status: 429, headers: CORS });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: CORS });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large." }, { status: 413, headers: CORS });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Send JSON with a productId and a quantity." }, { status: 400, headers: CORS });
  }
  const checkout = parseCheckoutRequest(body);
  if (!checkout) return NextResponse.json({ error: "Send a productId and a quantity from 1 to 10." }, { status: 400, headers: CORS });

  try {
    const started = await beginShopCheckout(await getDb(), { sitePublicId, request: checkout, portalBase: portalBase(request) });
    if (!started.ok) return NextResponse.json({ error: started.message, reason: started.reason }, { status: STATUS[started.reason] ?? 400, headers: CORS });
    return NextResponse.json({ url: started.url, order: started.orderPublicId }, { headers: CORS });
  } catch (error) {
    console.error("[public:shop-checkout] failed", { site: sitePublicId, message: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Checkout is unavailable right now." }, { status: 503, headers: CORS });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
