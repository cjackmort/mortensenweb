import { and, eq, isNotNull } from "drizzle-orm";
import { PLANS } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { servicePlans, subscriptions } from "@/db/schema";
import { stripeConfigured, TEST_PLAN } from "@/lib/payments/stripe";
import type { TenantContext } from "../context";
import { assignedPlanFor, resolveClient } from "./stripe-checkout";

/**
 * The plans a client can choose from when they set up automatic payments.
 *
 * Every published plan, with what it includes, so a client choosing can see
 * what the next tier up gets them. The $1 test plan appears only for a client
 * an operator assigned it to — the same rule checkout enforces.
 *
 * Closed, with a reason, when there is nothing to choose: a free plan, a
 * client a processor is already charging, or a portal without Stripe.
 */

export interface PlanCard {
  key: string;
  name: string;
  short: string;
  monthlyCents: number;
  description: string;
  bestFor: string | null;
  features: string[];
  includedChangesPerMonth: number | null;
  /** The plan most clients choose. */
  featured: boolean;
  /** The plan an operator assigned this client. */
  recommended: boolean;
}

export type PlanChoice =
  | { open: true; plans: PlanCard[]; billingDay: number | null }
  | { open: false; reason: "not_configured" | "no_client" | "complimentary" | "subscribed" };

export async function getPlanChoice(db: Database, ctx: TenantContext): Promise<PlanChoice> {
  if (!stripeConfigured()) return { open: false, reason: "not_configured" };

  const client = await resolveClient(db, ctx);
  if (!client) return { open: false, reason: "no_client" };
  if (client.compPlanId) return { open: false, reason: "complimentary" };

  const billed = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, client.clientId),
        eq(subscriptions.status, "active"),
        isNotNull(subscriptions.provider),
      ),
    )
    .limit(1);
  if (billed[0]) return { open: false, reason: "subscribed" };

  const [assigned, sellable] = await Promise.all([
    assignedPlanFor(db, client.clientId),
    db
      .select({ key: servicePlans.key })
      .from(servicePlans)
      .where(and(eq(servicePlans.active, true), isNotNull(servicePlans.stripePriceLookupKey))),
  ]);
  const onSale = new Set(sellable.map((plan) => plan.key));

  const plans: PlanCard[] = PLANS.filter((plan) => onSale.has(plan.key)).map((plan) => ({
    key: plan.key,
    name: plan.name,
    short: plan.short,
    monthlyCents: plan.monthlyCents,
    description: plan.description,
    bestFor: plan.bestFor,
    features: plan.features,
    includedChangesPerMonth: plan.includedChangesPerMonth,
    featured: Boolean(plan.featured),
    recommended: assigned?.planKey === plan.key,
  }));

  if (assigned?.planKey === TEST_PLAN.key && onSale.has(TEST_PLAN.key)) {
    plans.push({
      key: TEST_PLAN.key,
      name: TEST_PLAN.name,
      short: "Test",
      monthlyCents: TEST_PLAN.monthlyCents,
      // Not the row's description, which is written for the operator.
      description: "A plan for trying payments end to end.",
      bestFor: null,
      features: ["Charges $1 a month, so the whole payment flow can be tried for real"],
      includedChangesPerMonth: 1,
      featured: false,
      recommended: true,
    });
  }

  return { open: true, plans, billingDay: assigned?.billingDay ?? null };
}
