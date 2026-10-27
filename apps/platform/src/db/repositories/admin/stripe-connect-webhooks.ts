import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import { modeMatches, requireStripe } from "@/lib/payments/stripe";
import { accountStatusOf, connectedAccountIdOf, HANDLED_CONNECT_EVENTS } from "@/lib/shop/connect";
import { mirrorChargesEnabled } from "../client/shop-settings";
import { expireCheckoutSession, recordShopRefund, settleCheckoutSession } from "./shop-checkout";

/**
 * Turning Connect events into shop state.
 *
 * Same rules as the platform receiver (`stripe-webhooks.ts`): the event id
 * is the idempotency key, state is re-fetched rather than read off the
 * payload, and an event from the other mode is dropped.
 *
 * Four facts come through here: whether a shop can sell (`account.updated`),
 * that a checkout was paid or abandoned (`checkout.session.*`), and that a
 * charge was refunded. Each is applied by `shop-checkout.ts`, which is also
 * what the scheduler's sweep calls, so a lost webhook and a late one land in
 * the same place.
 *
 * Nothing here changes *which* account a shop pays into. An event can only
 * ever describe an account a client already connected.
 */

const PROVIDER = "stripe-connect";

export type ConnectOutcome =
  | { status: "processed"; note: string }
  | { status: "duplicate" }
  | { status: "ignored"; note: string }
  | { status: "unmatched"; note: string };

async function claimDelivery(db: Database, event: Stripe.Event): Promise<"claimed" | "retry" | "duplicate"> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({ provider: PROVIDER, deliveryId: event.id, event: event.type, signatureValid: true, status: "received" })
    .onConflictDoNothing({ target: [webhookDeliveries.provider, webhookDeliveries.deliveryId] })
    .returning({ id: webhookDeliveries.id });
  if (inserted.length > 0) return "claimed";

  const [existing] = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.provider, PROVIDER), eq(webhookDeliveries.deliveryId, event.id)))
    .limit(1);
  const status = existing?.status ?? "received";
  return status === "received" || status === "failed" ? "retry" : "duplicate";
}

async function markDelivery(db: Database, eventId: string, status: string): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status, processedAt: new Date() })
    .where(and(eq(webhookDeliveries.provider, PROVIDER), eq(webhookDeliveries.deliveryId, eventId)));
}

export async function processConnectEvent(db: Database, event: Stripe.Event): Promise<ConnectOutcome> {
  if (!modeMatches(event.livemode)) {
    return { status: "ignored", note: "event is from the other Stripe mode" };
  }
  if (!HANDLED_CONNECT_EVENTS.has(event.type)) {
    return { status: "ignored", note: `${event.type} is not handled` };
  }

  const claim = await claimDelivery(db, event);
  if (claim === "duplicate") return { status: "duplicate" };

  try {
    const outcome = await handle(db, event);
    await markDelivery(db, event.id, outcome.status === "processed" ? "processed" : outcome.status);
    return outcome;
  } catch (error) {
    await markDelivery(db, event.id, "failed");
    throw error;
  }
}

async function handle(db: Database, event: Stripe.Event): Promise<ConnectOutcome> {
  const accountId = connectedAccountIdOf(event);
  if (!accountId) return { status: "unmatched", note: "event names no connected account" };

  switch (event.type) {
    case "account.updated": {
      // Re-fetched, not read off the payload: two `account.updated` events
      // can arrive out of order, and the older one would otherwise switch a
      // shop off that Stripe has since switched on.
      const account = await requireStripe().accounts.retrieve(accountId);
      const status = accountStatusOf(account);
      const shops = await mirrorChargesEnabled(db, accountId, status.chargesEnabled);
      if (shops === 0) return { status: "unmatched", note: `no shop uses ${accountId}` };
      return {
        status: "processed",
        note: `${accountId} charges ${status.chargesEnabled ? "enabled" : "disabled"}`,
      };
    }
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // Re-fetched from the connected account: the payload is what the
      // session looked like when the event was made, which may be stale by
      // the time a retry delivers it.
      const sent = event.data.object as Stripe.Checkout.Session;
      const session = await requireStripe().checkout.sessions.retrieve(sent.id, undefined, { stripeAccount: accountId });
      const outcome = await settleCheckoutSession(db, session, { portalBase: portalBase() });
      return { status: outcome.status, note: outcome.note };
    }
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      const outcome = await expireCheckoutSession(db, session.id);
      return { status: outcome.status, note: outcome.note };
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const outcome = await recordShopRefund(db, charge);
      return { status: outcome.status, note: outcome.note };
    }
    default:
      return { status: "ignored", note: `${event.type} is not handled` };
  }
}

/** The portal's https origin, for the link in the "new order" email. */
function portalBase(): string | null {
  const configured = (process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  return configured.startsWith("https://") ? configured.replace(/[/]+$/, "") : null;
}
