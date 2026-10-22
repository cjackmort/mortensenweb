import { getDb } from "@/db/client";
import { unsubscribeRecipient } from "@/db/repositories/admin/winback";
import { ipFromHeaders } from "@/lib/auth/client-ip";
import { sha256Hex } from "@/lib/auth/password";
import { verifyUnsubscribeToken } from "@/lib/winback/unsubscribe-token";

/**
 * Unsubscribe from a business's win-back emails, as a POST only.
 *
 * Two callers. A mail app's one-click unsubscribe (RFC 8058, from the
 * `List-Unsubscribe-Post` header) POSTs `List-Unsubscribe=One-Click` and
 * wants a plain 200. The button on `/unsubscribe/<token>` POSTs a form and is
 * sent back to that page to read "done".
 *
 * A GET only redirects to the page: mail scanners open every link in an
 * email, and an unsubscribe that fired on GET would unsubscribe customers who
 * never asked to.
 *
 * Public, so it authenticates itself: the token's HMAC is checked before any
 * query, and `unsubscribeRecipient` limits each hashed IP to a few dozen an
 * hour. Every refusal is a 404 or 429 with no body.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const recipient = await verifyUnsubscribeToken(token);
  if (!recipient) return new Response(null, { status: 404 });

  const ip = ipFromHeaders(request.headers);
  const result = await unsubscribeRecipient(await getDb(), recipient, { ipHash: ip ? await sha256Hex(ip) : null });
  if (!result.ok) return new Response(null, { status: result.reason === "rate_limited" ? 429 : 404 });

  const form = await request.formData().catch(() => null);
  if (form?.get("List-Unsubscribe") === "One-Click") {
    return new Response("Unsubscribed.", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `/unsubscribe/${encodeURIComponent(token)}?done=1`, "Cache-Control": "no-store" },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return new Response(null, { status: 303, headers: { Location: `/unsubscribe/${encodeURIComponent(token)}` } });
}
