import { getDb } from "@/db/client";
import { recordReviewClick } from "@/db/repositories/admin/reviews";
import { allowReviewLinkRequest } from "@/lib/reviews/link-limiter";
import { verifyReviewToken } from "@/lib/reviews/tokens";

/**
 * The link in a review request: record the click, then send the customer to
 * the business's Google review form.
 *
 * Public by necessity — the customer has no account. The token is the
 * authorisation, and it is checked before the database is touched, so a
 * forged or mistyped link costs nothing and cannot keep Neon awake. Then a
 * per-address rate limit, for a real link being hammered.
 *
 * A forged link and an unknown one are the same 404, so probing learns
 * nothing about which requests exist. Rate-limited is an honest 429.
 *
 * `Referrer-Policy: no-referrer` keeps the token out of Google's logs, and
 * `no-store` stops a browser or proxy replaying the redirect without the
 * click being counted.
 */

export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response(null, { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!allowReviewLinkRequest(request.headers)) return new Response(null, { status: 429 });

  const { token } = await params;
  const publicId = await verifyReviewToken(token, "click");
  if (!publicId) return NOT_FOUND();

  const destination = await recordReviewClick(await getDb(), publicId);
  if (!destination) return NOT_FOUND();

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * A link checker or mail scanner asking whether the link works. Answered from
 * the signature alone: no query, and no click recorded — a scanner's HEAD is
 * not a customer opening the review form.
 */
export async function HEAD(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return new Response(null, { status: (await verifyReviewToken(token, "click")) ? 200 : 404 });
}
