import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { routeDeliveryEvent } from "@/db/repositories/admin/delivery-events";
import { parseResendEvent, verifySvixSignature } from "@/lib/email/resend-webhook";

/**
 * Resend's webhook: delivered, opened, clicked, bounced, complained.
 *
 * One endpoint for every feature that sends mail in bulk. The event's
 * `feature` tag picks the handler (`db/repositories/admin/delivery-events.ts`),
 * which records it and, for a bounce or a complaint, suppresses the address on
 * that feature's list. Mail without a feature tag is acknowledged and ignored.
 *
 * Public, so it authenticates itself: the Svix signature over the raw body,
 * with a five-minute replay window, is checked before anything is parsed or
 * any query runs. `RESEND_WEBHOOK_SECRET` unset refuses every delivery — an
 * endpoint that accepted unsigned events would let anyone suppress a client's
 * customers. The body is capped, so an unsigned flood costs one HMAC each.
 *
 * Answers 401 to a bad signature, 200 to anything verified it has no use for,
 * and 500 when a handler throws, so Resend retries.
 */

export const dynamic = "force-dynamic";

/** Resend's events are a few hundred bytes; this is generous. */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });

  const verified = await verifySvixSignature({
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    body,
    secret: process.env.RESEND_WEBHOOK_SECRET,
  });
  if (!verified) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });

  const event = parseResendEvent(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  try {
    const outcome = await routeDeliveryEvent(await getDb(), event);
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    console.error("[resend-webhook] handler failed", {
      type: event.type,
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Could not record the event." }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405 });
}
