/**
 * Sending events to the portal the way Stripe does: a JSON envelope, signed
 * with the endpoint's secret, POSTed to `/api/webhooks/stripe`.
 *
 * Split from the server so the one thing that must match Stripe byte for byte
 * — the signature — sits on its own. The portal verifies with
 * `stripe.webhooks.constructEventAsync`, which wants `t=<unix>,v1=<hmac>` over
 * `<unix>.<exact body>`; a re-serialised body would fail every check.
 */

import { createHmac } from "node:crypto";
import { STRIPE_API_VERSION } from "@/lib/payments/stripe";

export interface DeliveredEvent {
  id: string;
  type: string;
  /** The portal's HTTP status, or 0 when it could not be reached. */
  status: number;
  /** What the portal said it did with it (`processed`, `ignored`, ...), when it said. */
  outcome: string | null;
}

export function signedHeader(payload: string, secret: string, at = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex");
  return `t=${at},v1=${signature}`;
}

export function eventEnvelope(id: string, type: string, object: unknown): Record<string, unknown> {
  return {
    id,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    // Test mode. The portal drops an event whose `livemode` disagrees with its
    // key, so this is what a `sk_test_` portal expects to see.
    livemode: false,
    type,
    data: { object },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  };
}

export async function deliverEvent(
  portalUrl: string,
  secret: string,
  event: Record<string, unknown>,
): Promise<DeliveredEvent> {
  const body = JSON.stringify(event);
  const summary = { id: String(event.id), type: String(event.type) };
  try {
    const response = await fetch(`${portalUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signedHeader(body, secret) },
      body,
    });
    const reply = (await response.json().catch(() => null)) as { status?: string } | null;
    return { ...summary, status: response.status, outcome: reply?.status ?? null };
  } catch (error) {
    console.error(`[fake-stripe] could not reach ${portalUrl}:`, error instanceof Error ? error.message : error);
    return { ...summary, status: 0, outcome: null };
  }
}
