import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getDb } from "@/db/client";
import { processConnectEvent } from "@/db/repositories/admin/stripe-connect-webhooks";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";

/**
 * Stripe's webhook endpoint for connected accounts — the clients' shops.
 *
 * A second endpoint with its own signing secret, because Stripe delivers
 * events about connected accounts only to endpoints registered for Connect,
 * and signs them with that endpoint's secret. It is otherwise the platform
 * receiver (`../stripe/route.ts`) line for line: the raw body is verified
 * before anything parses it, a bad signature is the one case that answers
 * with an error, and a processing failure answers 500 so Stripe retries.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const signingSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

  if (!stripeConfigured() || !signingSecret) {
    // Refuse rather than accept unverified notifications: this endpoint
    // decides whether a shop can take money.
    return NextResponse.json({ error: "Webhook receiver is not configured." }, { status: 503 });
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
    event = await requireStripe().webhooks.constructEventAsync(rawBody, signature, signingSecret);
  } catch (error) {
    console.warn("[webhook:stripe-connect] signature rejected", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  const db = await getDb();

  try {
    const outcome = await processConnectEvent(db, event);
    return NextResponse.json({ status: outcome.status }, { status: 200 });
  } catch (error) {
    console.error("[webhook:stripe-connect] processing failed", {
      eventId: event.id,
      type: event.type,
      account: event.account ?? null,
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
