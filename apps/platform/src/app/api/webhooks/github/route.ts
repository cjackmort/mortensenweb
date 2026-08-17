import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { processGithubDelivery } from "@/db/repositories/admin/webhooks";
import { verifyGithubSignature } from "@/lib/webhooks/signature";

/**
 * GitHub's webhook endpoint.
 *
 * Unauthenticated by design — GitHub cannot hold a session — so the HMAC
 * signature *is* the authentication, and everything below is arranged so that
 * it cannot be accidentally bypassed.
 *
 * ## The raw body rule
 *
 * `request.text()` is read once, first, and the signature is computed over
 * exactly those bytes. `JSON.parse` happens afterwards, on a string we have
 * already verified. The tempting alternative — `await request.json()` and then
 * re-serialise for the HMAC — does not work, because `JSON.stringify` does not
 * reproduce the sender's byte sequence: key order survives, but unicode escapes
 * and number formatting do not. It fails for legitimate deliveries, and the
 * obvious "fix" is to weaken the check.
 *
 * ## Why almost everything returns 2xx
 *
 * GitHub disables a webhook that keeps erroring. A malformed payload, an
 * unknown event, or a repository we do not manage are all *expected* traffic on
 * a public endpoint, and answering 500 to them would eventually take the
 * integration down. They are acknowledged and dropped.
 *
 * A bad signature is the exception: it gets 401, because it is either a
 * misconfiguration worth noticing immediately or someone probing.
 */

// This handler must run per-request against the database, and it reads a raw
// body — neither is compatible with any caching.
export const dynamic = "force-dynamic";

/** GitHub's cap is 25 MB; nothing we handle approaches it. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than accept unverified deliveries. An endpoint that
    // processes anything when misconfigured is worse than one that is down:
    // the failure is invisible and the consequence is arbitrary repository
    // writes triggered by anyone who finds the URL.
    return NextResponse.json(
      { error: "Webhook receiver is not configured." },
      { status: 503 },
    );
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");

  if (!deliveryId || !event) {
    return NextResponse.json({ error: "Missing headers." }, { status: 400 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  // Read once, verify these exact bytes, parse afterwards.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const signatureValid = await verifyGithubSignature(rawBody, signature, secret);

  let payload: unknown = null;
  if (signatureValid) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Verified as ours, but not JSON. Record it as a processed-and-ignored
      // delivery rather than 400, so the receiver stays healthy.
      payload = null;
    }
  }

  const db = await getDb();

  try {
    const outcome = await processGithubDelivery(db, {
      deliveryId,
      event,
      payload,
      signatureValid,
    });

    if (outcome.status === "rejected" && !signatureValid) {
      return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    }

    // 202: received and dealt with. The body names the outcome for the delivery
    // log in GitHub's UI, which is where an operator debugs this from.
    return NextResponse.json({ status: outcome.status }, { status: 202 });
  } catch (error) {
    // Log internally; the response says nothing. GitHub retries on 500, which
    // is the behaviour we want for a genuine processing fault — and the
    // delivery row is already marked failed, so the retry is idempotent.
    console.error("[webhook:github] processing failed", {
      deliveryId,
      event,
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

/**
 * A GET here is someone poking at the URL. Say nothing useful.
 */
export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
