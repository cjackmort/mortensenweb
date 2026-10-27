import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";
import { modeMatches, requireStripe } from "@/lib/payments/stripe";
import { accountStatusOf, connectedAccountIdOf, HANDLED_CONNECT_EVENTS } from "@/lib/shop/connect";
import { mirrorChargesEnabled } from "../client/shop-settings";

/**
 * Turning Connect events into shop state.
 *
 * Same rules as the platform receiver (`stripe-webhooks.ts`): the event id is
 * the idempotency key, the account's state is re-fetched rather than read off
 * the payload, and an event from the other mode is dropped. The one thing it
 * writes today is `charges_enabled` on the shop that uses the account — the
 * fact that decides whether that shop can sell.
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
    default:
      return { status: "ignored", note: `${event.type} is not handled` };
  }
}
