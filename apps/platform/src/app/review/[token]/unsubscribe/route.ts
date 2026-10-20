import { getDb } from "@/db/client";
import { unsubscribeReviewRequest } from "@/db/repositories/admin/reviews";
import { allowReviewLinkRequest } from "@/lib/reviews/link-limiter";
import { verifyReviewToken } from "@/lib/reviews/tokens";

/**
 * Unsubscribe, as a POST only.
 *
 * Two callers. A mail provider's one-click unsubscribe (RFC 8058: the
 * `List-Unsubscribe-Post` header) POSTs `List-Unsubscribe=One-Click` here and
 * wants a plain 200. The button on `/review/<token>/stop` POSTs a form and is
 * sent back to that page to read "done".
 *
 * A GET only redirects to the page. Mail scanners open every link in an
 * email, and an unsubscribe that fired on GET would unsubscribe customers
 * nobody asked to.
 *
 * Public, with the same checks as the click link: the token (signed for
 * `stop`, so a click link cannot be edited into one) before any query, then
 * the rate limit. Every refusal is a 404.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!allowReviewLinkRequest(request.headers)) return new Response(null, { status: 429 });

  const { token } = await params;
  const publicId = await verifyReviewToken(token, "stop");
  if (!publicId) return new Response(null, { status: 404 });

  const done = await unsubscribeReviewRequest(await getDb(), publicId);
  if (!done) return new Response(null, { status: 404 });

  const form = await request.formData().catch(() => null);
  if (form?.get("List-Unsubscribe") === "One-Click") {
    return new Response("Unsubscribed.", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `/review/${encodeURIComponent(token)}/stop?done=1`, "Cache-Control": "no-store" },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return new Response(null, { status: 303, headers: { Location: `/review/${encodeURIComponent(token)}/stop` } });
}
