import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, subscriptions } from "@/db/schema";
import {
  describeDiscounts,
  SUBSCRIPTION_EXPAND,
  usablePromo,
} from "@/lib/payments/promos";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import type { AdminContext } from "../context";

/**
 * An operator giving one client a promo.
 *
 * Two cases, decided by whether Stripe is already charging them:
 *
 *  - **Not yet paying by card.** The promo is saved on the client and applied
 *    to their checkout — the payment link an operator sends, and the client's
 *    own "set up automatic payment" button alike. Nothing is charged here.
 *  - **Already paying by card.** The promo goes onto the live subscription
 *    and applies from their next payment. Stripe replaces any discount the
 *    subscription already had, which the form says before it is pressed.
 *
 * Removing a promo only ever clears the saved one. Taking a discount off a
 * live subscription raises what somebody pays, and that is done deliberately,
 * in Stripe, not from a dropdown here.
 */

export interface ClientPromoView {
  /** The promo saved for their next checkout. */
  promoCode: string | null;
  promoTerms: string | null;
}

export async function getClientPromo(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<ClientPromoView | null> {
  const rows = await db
    .select({ promoCode: clients.promoCode, promoTerms: clients.promoTerms })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  return rows[0] ?? null;
}

export type AttachPromoResult = { ok: boolean; message: string };

export async function attachPromo(
  ctx: AdminContext,
  db: Database,
  input: { clientPublicId: string; promoCodeId: string | null },
): Promise<AttachPromoResult> {
  if (!stripeConfigured()) {
    return { ok: false, message: "Card payments aren't set up here, so there are no promos to give." };
  }

  const client = (
    await db
      .select({
        id: clients.id,
        organizationId: clients.organizationId,
        compPlanId: clients.compPlanId,
      })
      .from(clients)
      .where(eq(clients.publicId, input.clientPublicId))
      .limit(1)
  )[0];
  if (!client) return { ok: false, message: "No such client." };

  if (client.compPlanId) {
    return { ok: false, message: "They're on a free plan, so there's nothing to discount." };
  }

  const active = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.clientId, client.id), eq(subscriptions.status, "active")));
  if (active.some((row) => row.provider === "square")) {
    return { ok: false, message: "They pay through Square, which promos here can't reach." };
  }
  const onStripe = active.find((row) => row.provider === "stripe" && row.providerSubscriptionId);

  if (!input.promoCodeId) {
    await db
      .update(clients)
      .set({ promoCodeId: null, promoCode: null, promoTerms: null, updatedAt: new Date() })
      .where(eq(clients.id, client.id));
    await audit(db, ctx, client.organizationId, input.clientPublicId, "promo.removed", {});
    return {
      ok: true,
      message: onStripe
        ? "Removed. Any discount already on their subscription stays until it ends; to end it sooner, remove it in Stripe."
        : "Removed. Their checkout won't include a promo.",
    };
  }

  const promo = await usablePromo(input.promoCodeId);
  if (!promo) {
    return { ok: false, message: "That code can't be redeemed any more. Check it in Stripe." };
  }

  if (!onStripe) {
    await db
      .update(clients)
      .set({
        promoCodeId: promo.id,
        promoCode: promo.code,
        promoTerms: promo.terms,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, client.id));
    await audit(db, ctx, client.organizationId, input.clientPublicId, "promo.attached", {
      code: promo.code,
      via: "checkout",
    });
    return {
      ok: true,
      message: `Saved. ${promo.code} (${promo.terms}) will be applied when they set up automatic payment.`,
    };
  }

  const subscriptionId = onStripe.providerSubscriptionId!;
  try {
    const updated = await requireStripe().subscriptions.update(
      subscriptionId,
      { discounts: [{ promotion_code: promo.id }], expand: SUBSCRIPTION_EXPAND },
      { idempotencyKey: `promo:${subscriptionId}:${promo.id}` },
    );

    // The webhook mirrors this too. Writing it now means the page shows the
    // promo straight away rather than after the event lands.
    const discount = await describeDiscounts(updated, onStripe.monthlyPriceCents);
    if (discount) {
      await db.update(subscriptions).set(discount).where(eq(subscriptions.id, onStripe.id));
    }
  } catch (error) {
    console.error("[promos] stripe refused the promo", {
      subscription: subscriptionId,
      message: error instanceof Error ? error.message : "unknown",
    });
    const refused = (error as { type?: string } | null)?.type === "StripeInvalidRequestError";
    return {
      ok: false,
      message: refused && error instanceof Error
        ? `Stripe wouldn't apply it: ${error.message}`
        : "Stripe didn't accept the promo. Try again.",
    };
  }

  await audit(db, ctx, client.organizationId, input.clientPublicId, "promo.attached", {
    code: promo.code,
    via: "subscription",
    subscriptionId,
  });
  return {
    ok: true,
    message: `Applied. ${promo.code} (${promo.terms}) starts with their next payment.`,
  };
}

async function audit(
  db: Database,
  ctx: AdminContext,
  organizationId: string,
  clientPublicId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId,
    action,
    entityType: "client",
    entityId: clientPublicId,
    metadata,
  });
}
