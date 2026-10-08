import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { shiftedAnchor } from "@/lib/billing/billing-day";
import {
  planForLookupKey,
  planItemOf,
  priceForPlan,
  requireStripe,
  stripeConfigured,
} from "@/lib/payments/stripe";
import { describeDiscounts, SUBSCRIPTION_EXPAND } from "@/lib/payments/promos";

/**
 * Changing the plan or payment day of a client Stripe is already charging.
 *
 * Two rules, both about never charging twice for the same days:
 *
 *  - A new plan takes effect from the next payment, with no proration. The
 *    client is not charged or credited today; the next invoice is simply at
 *    the new price.
 *  - A new payment day falls after the period they have already paid for,
 *    never inside it. Stripe moves a renewal date by ending a trial on it
 *    (`trial_end`), so the days between the old renewal and the new one are
 *    uncharged. A few free days is the safe direction to be wrong in.
 *
 * Stripe stays the record of what is charged: the webhook mirrors the result
 * back. The local row is updated as well so the page reflects the change
 * before that lands.
 */

type SubscriptionRow = typeof subscriptions.$inferSelect;

export async function changeStripePlan(
  db: Database,
  input: {
    row: SubscriptionRow;
    plan: { id: string; key: string; name: string; monthlyCents: number; lookupKey: string };
    billingDay: number;
  },
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const { row, plan, billingDay } = input;

  if (!stripeConfigured() || !row.providerSubscriptionId) {
    return { ok: false, message: "Card payments aren't set up here, so their Stripe plan can't be changed." };
  }

  let planChanged: boolean;
  let said: string[];
  let updated: Stripe.Subscription | null;
  try {
    ({ planChanged, said, updated } = await updateLiveSubscription(row.providerSubscriptionId, plan, billingDay));
  } catch (error) {
    console.error("[billing-plan] stripe update failed", {
      subscription: row.providerSubscriptionId,
      message: error instanceof Error ? error.message : "unknown",
    });
    const message = error instanceof RefusedChange ? error.message : "Stripe didn't accept the change. Try again.";
    return { ok: false, message };
  }

  // A promo is a percentage or an amount off the plan price, so a new plan
  // moves the promo price too.
  const discount =
    planChanged && updated ? await describeDiscounts(updated, plan.monthlyCents) : undefined;

  await db
    .update(subscriptions)
    .set({
      billingDay,
      ...(planChanged ? { planId: plan.id, monthlyPriceCents: plan.monthlyCents } : {}),
      ...(discount ?? {}),
    })
    .where(eq(subscriptions.id, row.id));

  return {
    ok: true,
    message: said.length > 0 ? `Saved. Stripe will charge ${said.join("; ")}.` : "Saved. Stripe already charges this.",
  };
}

/** A change Stripe can't make, with the reason in words for the operator. */
class RefusedChange extends Error {}

async function updateLiveSubscription(
  subscriptionId: string,
  plan: { key: string; name: string; lookupKey: string },
  billingDay: number,
): Promise<{ planChanged: boolean; said: string[]; updated: Stripe.Subscription | null }> {
  const stripe = requireStripe();
  const live = await stripe.subscriptions.retrieve(subscriptionId);
  const item = planItemOf(live);
  if (!item) throw new RefusedChange("Their Stripe subscription has no plan on it. Check it in Stripe.");

  const params: Stripe.SubscriptionUpdateParams = { proration_behavior: "none" };
  const said: string[] = [];

  if (item.price.lookup_key !== plan.lookupKey) {
    const sellable = planForLookupKey(plan.lookupKey);
    const price = sellable ? await priceForPlan(sellable) : null;
    if (!price) throw new RefusedChange(`${plan.name} has no price in Stripe yet.`);
    params.items = [{ id: item.id, price: price.id }];
    params.metadata = { plan_key: plan.key };
    said.push(`${plan.name} from their next payment`);
  }

  const periodEnd =
    (item as unknown as { current_period_end?: number }).current_period_end ??
    (live as unknown as { current_period_end?: number }).current_period_end ??
    null;
  const anchor = periodEnd ? shiftedAnchor(billingDay, periodEnd) : null;
  if (anchor !== null) {
    params.trial_end = anchor;
    said.push(`next payment on ${longDate(anchor)}, then on that day each month`);
  }

  let updated: Stripe.Subscription | null = null;
  if (params.items || params.trial_end) {
    updated = await stripe.subscriptions.update(
      live.id,
      { ...params, expand: SUBSCRIPTION_EXPAND },
      { idempotencyKey: `assign-plan:${live.id}:${plan.key}:${billingDay}:${periodEnd ?? "none"}` },
    );
  }

  return { planChanged: Boolean(params.items), said, updated };
}

function longDate(seconds: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(seconds * 1000),
  );
}
