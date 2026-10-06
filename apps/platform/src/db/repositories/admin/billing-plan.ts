import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, servicePlans, subscriptions } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { ordinal, parseBillingDay } from "@/lib/billing/billing-day";
import { newPublicId } from "@/lib/ids";
import type { AdminContext } from "../context";
import { changeStripePlan } from "./billing-plan-stripe";

/**
 * The plan an operator puts a client on, and the day of the month they pay.
 *
 * Before Stripe, a client's plan was a `subscriptions` row with no provider —
 * how a client paid by Venmo or cash has a plan at all. That same row is what
 * this writes. It is the plan the client is offered at checkout (through
 * `getEntitlements`), its `billing_day` is the day Stripe anchors the
 * subscription on, and once Stripe takes over the webhook retires it.
 *
 * For a client already paying through Stripe the live subscription is changed
 * instead — see `billing-plan-stripe.ts` — and a Square mandate is refused,
 * because this screen cannot reach Square and an edit here would only make the
 * portal disagree with what Square charges.
 */

export interface AssignablePlan {
  key: string;
  name: string;
  monthlyCents: number;
  includedChangesPerMonth: number | null;
}

/** Plans Stripe can charge for, in the order they are sold. */
export async function listAssignablePlans(db: Database): Promise<AssignablePlan[]> {
  return db
    .select({
      key: servicePlans.key,
      name: servicePlans.name,
      monthlyCents: servicePlans.defaultMonthlyCents,
      includedChangesPerMonth: servicePlans.includedChangesPerMonth,
    })
    .from(servicePlans)
    // No lookup key means not sold — which is how the comp plan is kept out.
    .where(and(eq(servicePlans.active, true), isNotNull(servicePlans.stripePriceLookupKey)))
    .orderBy(asc(servicePlans.sortOrder), asc(servicePlans.defaultMonthlyCents));
}

export interface BillingPlanView {
  planKey: string | null;
  planName: string | null;
  monthlyPriceCents: number;
  currency: string;
  billingDay: number;
  /** `stripe`, `square`, or null for a plan billed by hand. */
  provider: string | null;
  providerStatus: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** A promo on their Stripe subscription. See `discountApplies`. */
  discountLabel: string | null;
  discountedPriceCents: number | null;
  discountEndsAt: Date | null;
}

/** The client's current plan, preferring the one a processor is billing. */
export async function getBillingPlan(
  db: Database,
  clientId: string,
): Promise<BillingPlanView | null> {
  const rows = await db
    .select({
      planKey: servicePlans.key,
      planName: servicePlans.name,
      monthlyPriceCents: subscriptions.monthlyPriceCents,
      currency: subscriptions.currency,
      billingDay: subscriptions.billingDay,
      provider: subscriptions.provider,
      providerStatus: subscriptions.providerStatus,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      discountLabel: subscriptions.discountLabel,
      discountedPriceCents: subscriptions.discountedPriceCents,
      discountEndsAt: subscriptions.discountEndsAt,
    })
    .from(subscriptions)
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(and(eq(subscriptions.clientId, clientId), eq(subscriptions.status, "active")))
    // Postgres sorts nulls last ascending, so a processor's row comes first.
    .orderBy(asc(subscriptions.provider), desc(subscriptions.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

export type AssignPlanResult = { ok: true; message: string } | { ok: false; message: string };

export interface AssignPlanInput {
  clientPublicId: string;
  planKey: string;
  billingDay: number;
}

export async function assignBillingPlan(
  ctx: AdminContext,
  db: Database,
  input: AssignPlanInput,
): Promise<AssignPlanResult> {
  const billingDay = parseBillingDay(String(input.billingDay));
  if (billingDay === null) {
    return { ok: false, message: "Choose a day from the 1st to the 28th." };
  }

  const plan = (
    await db
      .select({
        id: servicePlans.id,
        key: servicePlans.key,
        name: servicePlans.name,
        monthlyCents: servicePlans.defaultMonthlyCents,
        lookupKey: servicePlans.stripePriceLookupKey,
        active: servicePlans.active,
      })
      .from(servicePlans)
      .where(eq(servicePlans.key, input.planKey))
      .limit(1)
  )[0];
  if (!plan || !plan.active || !plan.lookupKey) {
    return { ok: false, message: "That plan can't be charged for. Choose another." };
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

  const active = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.clientId, client.id), eq(subscriptions.status, "active")));

  if (active.some((row) => row.provider === "square")) {
    return {
      ok: false,
      message: "They pay through Square. Change their plan in Square instead.",
    };
  }

  const onStripe = active.find((row) => row.provider === "stripe");
  const result = onStripe
    ? await changeStripePlan(db, { row: onStripe, plan: { ...plan, lookupKey: plan.lookupKey }, billingDay })
    : await saveHandBilledPlan(db, {
        clientId: client.id,
        row: active.find((row) => row.provider === null) ?? null,
        plan,
        billingDay,
      });
  if (!result.ok) return result;

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "subscription.assigned",
    entityType: "client",
    entityId: input.clientPublicId,
    metadata: { planKey: plan.key, billingDay, via: onStripe ? "stripe" : "hand" },
  });

  // A comp still wins: the paid plan is what applies once it is withdrawn.
  const compNote = client.compPlanId
    ? " They're on a free plan right now, so nothing is charged until that's removed."
    : "";
  return { ok: true, message: result.message + compNote };
}

async function saveHandBilledPlan(
  db: Database,
  input: {
    clientId: string;
    row: typeof subscriptions.$inferSelect | null;
    plan: { id: string; name: string; monthlyCents: number };
    billingDay: number;
  },
): Promise<AssignPlanResult> {
  const { row, plan, billingDay } = input;

  if (row) {
    // Same plan keeps the price it was agreed at. Only a change of plan moves
    // the client to that plan's price.
    const samePlan = row.planId === plan.id;
    await db
      .update(subscriptions)
      .set({
        planId: plan.id,
        billingDay,
        monthlyPriceCents: samePlan ? row.monthlyPriceCents : plan.monthlyCents,
      })
      .where(and(eq(subscriptions.id, row.id), isNull(subscriptions.provider)));
  } else {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: input.clientId,
      planId: plan.id,
      monthlyPriceCents: plan.monthlyCents,
      billingDay,
      startedOn: businessDate(),
    });
  }

  return {
    ok: true,
    message: `Saved. They'll be offered ${plan.name} when they set up automatic payments, charged on the ${ordinal(billingDay)} of each month.`,
  };
}
