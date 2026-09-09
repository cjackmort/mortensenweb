import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getDb } from "@/db/client";
import { processStripeEvent } from "@/db/repositories/admin/stripe-webhooks";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";

/**
 * Stripe's webhook endpoint.
 *
 * Same shape as the GitHub and Square receivers: the raw body is read once and
 * verified before anything parses it, a bad signature is the one case that
 * answers with an error, and processing failures answer 500 so the sender
 * retries.
 *
 * ## The raw body, and why `request.text()` is load-bearing
 *
 * Stripe signs the exact bytes it sent. `request.json()` would parse and
 * discard them, and re-serialising the object afterwards produces different
 * bytes — different key order, different whitespace, different unicode
 * escaping — so every signature check would fail. Reading `text()` once, and
 * verifying that string, is the only correct order.
 *
 * ## Why this route pins `dynamic` and never caches
 *
 * A cached webhook response would acknowledge deliveries that were never
 * processed, and Stripe would stop retrying them.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeConfigured() || !signingSecret) {
    // Refuse rather than accept unverified notifications. This endpoint
    // confirms payments and unlocks paid features; one that processed anything
    // while misconfigured would let anybody who found the URL grant themselves
    // an account.
    return NextResponse.json(
      { error: "Webhook receiver is not configured." },
      { status: 503 },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 401 });
  }

  let event: Stripe.Event;
  try {
    // `constructEventAsync` rather than the sync form: the sync one uses
    // Node's crypto directly, which is not available on the edge runtime this
    // app can be deployed to. The async form uses WebCrypto and works in both.
    event = await requireStripe().webhooks.constructEventAsync(
      rawBody,
      signature,
      signingSecret,
    );
  } catch (error) {
    // Includes both a forged signature and a genuine one outside the
    // tolerance window — a replay. Neither is processed.
    console.warn("[webhook:stripe] signature rejected", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  const db = await getDb();

  try {
    const outcome = await processStripeEvent(db, event);
    return NextResponse.json({ status: outcome.status }, { status: 200 });
  } catch (error) {
    console.error("[webhook:stripe] processing failed", {
      eventId: event.id,
      type: event.type,
      message: error instanceof Error ? error.message : "unknown",
    });
    // 500 so Stripe retries. The delivery row is left un-processed and the
    // event id is the idempotency key, so a retry re-runs the work rather than
    // being swallowed as a duplicate — which is the behaviour that makes a
    // transient database failure recoverable instead of a lost payment.
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
