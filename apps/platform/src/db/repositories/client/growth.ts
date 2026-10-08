import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  GROWTH_FEATURES,
  PLANS,
  type GrowthFeatureKey,
  type PlanKey,
} from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { auditLog, clientAddOns, clients, leads, servicePlans, subscriptions } from "@/db/schema";
import { growthAccess, hasFeature, type FeatureAccess } from "@/lib/growth/access";
import {
  lookupKeyForPlan,
  planItemOf,
  priceForAddOn,
  priceForPlan,
  requireStripe,
  stripeConfigured,
} from "@/lib/payments/stripe";
import { assertMutable, type TenantContext } from "../context";
import { getEntitlements } from "./entitlements";

/**
 * The Growth tab and the Plan tab, from the client's side.
 *
 * Reads: what they have and why (`lib/growth/access.ts` decides), and the
 * state of their subscription. Writes: add or remove a Growth add-on, move
 * to another plan, and schedule or undo a cancellation — each on the caller's
 * own Stripe subscription, found from the session's organization and never
 * from anything the browser sent.
 *
 * Every write takes effect at Stripe first and is mirrored here second, the
 * same order the webhook would apply it in; the webhook arriving afterwards
 * re-mirrors the same facts and changes nothing.
 *
 * ## No proration
 *
 * Changes are priced from the next payment (`proration_behavior: "none"`),
 * the rule the operator's own plan changes already follow. A client who adds
 * a feature mid-month gets it now and starts paying for it at the next
 * charge, rather than receiving a confusing part-month invoice for $3.17.
 */

export type GrowthBilling =
  /** Paying by card through Stripe: everything here is self-serve. */
  | "stripe"
  /** On the house: they already have every feature. */
  | "complimentary"
  /** Invoiced by hand (Venmo, Square, cheque): changes go through us. */
  | "invoiced"
  /** No plan set up yet. */
  | "none";

export interface GrowthState {
  access: FeatureAccess[];
  planKey: string | null;
  planName: string | null;
  monthlyPriceCents: number | null;
  billing: GrowthBilling;
  /** A Stripe cancellation is scheduled: the plan ends on this date. */
  cancelsOn: Date | null;
  renewsOn: Date | null;
  addOns: Array<{ featureKey: GrowthFeatureKey; source: string; monthlyPriceCents: number | null; startedAt: Date }>;
  /** Open enquiries — shown on a locked inbox as a reason to unlock it. */
  waitingLeads: number;
}

interface StripeSubscriptionRow {
  id: string;
  clientId: string;
  providerSubscriptionId: string;
  cancelAtPeriodEnd: boolean | null;
  currentPeriodEnd: Date | null;
}

async function clientIdFor(db: Database, ctx: TenantContext): Promise<string | null> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  return row?.id ?? null;
}

async function activeSubscription(db: Database, clientId: string) {
  const [row] = await db
    .select({
      id: subscriptions.id,
      clientId: subscriptions.clientId,
      provider: subscriptions.provider,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.clientId, clientId), eq(subscriptions.status, "active")))
    .limit(1);
  return row ?? null;
}

async function stripeSubscriptionFor(
  db: Database,
  ctx: TenantContext,
): Promise<StripeSubscriptionRow | null> {
  const clientId = await clientIdFor(db, ctx);
  if (!clientId) return null;
  const row = await activeSubscription(db, clientId);
  if (!row || row.provider !== "stripe" || !row.providerSubscriptionId) return null;
  return { ...row, providerSubscriptionId: row.providerSubscriptionId };
}

export async function getGrowthState(db: Database, ctx: TenantContext): Promise<GrowthState> {
  const entitlements = await getEntitlements(db, ctx);
  const clientId = await clientIdFor(db, ctx);

  const addOnRows = clientId
    ? await db
        .select({
          featureKey: clientAddOns.featureKey,
          source: clientAddOns.source,
          monthlyPriceCents: clientAddOns.monthlyPriceCents,
          startedAt: clientAddOns.startedAt,
        })
        .from(clientAddOns)
        .where(and(eq(clientAddOns.clientId, clientId), isNull(clientAddOns.endedAt)))
    : [];
  const addOns = addOnRows.filter((r): r is typeof r & { featureKey: GrowthFeatureKey } =>
    GROWTH_FEATURES.some((f) => f.key === r.featureKey),
  );

  const sub = clientId ? await activeSubscription(db, clientId) : null;
  const comped = entitlements?.comped ?? false;
  const billing: GrowthBilling = comped
    ? "complimentary"
    : sub?.provider === "stripe"
      ? "stripe"
      : sub
        ? "invoiced"
        : "none";

  const [waiting] = await db
    .select({ n: count() })
    .from(leads)
    .where(
      and(
        eq(leads.organizationId, ctx.organizationId),
        isNull(leads.deletedAt),
        inArray(leads.status, ["new", "contacted"]),
      ),
    );

  return {
    access: growthAccess({
      planKey: entitlements?.planKey ?? null,
      comped,
      addOns: addOns.map((a) => a.featureKey),
    }),
    planKey: entitlements?.planKey ?? null,
    planName: entitlements?.planName ?? null,
    monthlyPriceCents: entitlements?.monthlyPriceCents ?? null,
    billing,
    cancelsOn: sub?.cancelAtPeriodEnd ? (sub.currentPeriodEnd ?? null) : null,
    renewsOn: sub && !sub.cancelAtPeriodEnd ? (sub.currentPeriodEnd ?? null) : null,
    addOns,
    waitingLeads: waiting?.n ?? 0,
  };
}

/** Whether the caller has a Growth feature — the gate on each feature's pages. */
export async function requireGrowthFeature(
  db: Database,
  ctx: TenantContext,
  key: GrowthFeatureKey,
): Promise<boolean> {
  // An operator viewing as the client sees what the client sees, including
  // a locked page.
  return hasFeature((await getGrowthState(db, ctx)).access, key);
}

export type ChangeResult = { ok: true; message: string } | { ok: false; message: string };

const NOT_SELF_SERVE: ChangeResult = {
  ok: false,
  message: "Changes to your plan go through us for now — reply to any of our emails and we'll sort it.",
};

async function audit(
  db: Database,
  ctx: TenantContext,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    action,
    entityType: "subscription",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata,
  });
}

/** Add a built Growth feature to the caller's Stripe subscription. */
export async function addGrowthAddOn(
  db: Database,
  ctx: TenantContext,
  featureKey: string,
): Promise<ChangeResult> {
  assertMutable(ctx);
  const feature = GROWTH_FEATURES.find((f) => f.key === featureKey);
  if (!feature) return { ok: false, message: "That feature does not exist." };
  if (!feature.available) return { ok: false, message: `${feature.name} is not ready yet.` };

  const state = await getGrowthState(db, ctx);
  if (state.access.find((a) => a.feature.key === feature.key)?.via) {
    return { ok: false, message: `You already have ${feature.name}.` };
  }
  if (!stripeConfigured()) return NOT_SELF_SERVE;
  const sub = await stripeSubscriptionFor(db, ctx);
  if (!sub) return NOT_SELF_SERVE;

  const price = await priceForAddOn(feature.key);
  if (!price) return { ok: false, message: `${feature.name} cannot be bought just yet. Please contact us.` };

  try {
    const item = await requireStripe().subscriptionItems.create({
      subscription: sub.providerSubscriptionId,
      price: price.id,
      proration_behavior: "none",
      metadata: { growth_feature: feature.key },
    });
    await db
      .insert(clientAddOns)
      .values({
        clientId: sub.clientId,
        featureKey: feature.key,
        source: "stripe",
        stripeSubscriptionItemId: item.id,
        monthlyPriceCents: price.unit_amount ?? feature.addOnCents,
      })
      .onConflictDoNothing();
    await audit(db, ctx, "growth.add_on_added", { feature: feature.key, item: item.id });
  } catch (error) {
    console.error("[growth] add-on failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "We could not add that just now. Nothing was charged." };
  }

  return {
    ok: true,
    message: `${feature.name} is on. It is added to your monthly payment from your next one.`,
  };
}

/** Remove a Growth add-on the caller bought through Stripe. */
export async function removeGrowthAddOn(
  db: Database,
  ctx: TenantContext,
  featureKey: string,
): Promise<ChangeResult> {
  assertMutable(ctx);
  const clientId = await clientIdFor(db, ctx);
  if (!clientId) return NOT_SELF_SERVE;
  const [row] = await db
    .select({ id: clientAddOns.id, source: clientAddOns.source, item: clientAddOns.stripeSubscriptionItemId })
    .from(clientAddOns)
    .where(
      and(
        eq(clientAddOns.clientId, clientId),
        eq(clientAddOns.featureKey, featureKey),
        isNull(clientAddOns.endedAt),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, message: "You do not have that add-on." };
  // One the operator granted is theirs to take away, not a line on the
  // client's card the client can cancel.
  if (row.source !== "stripe" || !row.item) return NOT_SELF_SERVE;

  try {
    await requireStripe().subscriptionItems.del(row.item, { proration_behavior: "none" });
  } catch (error) {
    console.error("[growth] add-on removal failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "We could not remove that just now. Please try again." };
  }
  const now = new Date();
  await db.update(clientAddOns).set({ endedAt: now, updatedAt: now }).where(eq(clientAddOns.id, row.id));
  await audit(db, ctx, "growth.add_on_removed", { feature: featureKey, item: row.item });

  const name = GROWTH_FEATURES.find((f) => f.key === featureKey)?.name ?? "That add-on";
  return { ok: true, message: `${name} is removed. You will not be charged for it again.` };
}

/** Move the caller to another published plan, priced from their next payment. */
export async function changeMyPlan(
  db: Database,
  ctx: TenantContext,
  planKey: string,
): Promise<ChangeResult> {
  assertMutable(ctx);
  const plan = PLANS.find((p) => p.key === planKey);
  if (!plan) return { ok: false, message: "Pick one of the plans shown." };
  if (!stripeConfigured()) return NOT_SELF_SERVE;
  const sub = await stripeSubscriptionFor(db, ctx);
  if (!sub) return NOT_SELF_SERVE;

  const stripe = requireStripe();
  const price = await priceForPlan(plan.key as PlanKey);
  if (!price) return { ok: false, message: `${plan.name} cannot be chosen just yet. Please contact us.` };

  try {
    const live = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
    const item = planItemOf(live);
    if (!item) return { ok: false, message: "We could not find your plan on your subscription. Please contact us." };
    if (item.price.lookup_key === lookupKeyForPlan(plan.key as PlanKey)) {
      return { ok: false, message: `You are already on ${plan.name}.` };
    }
    await stripe.subscriptions.update(sub.providerSubscriptionId, {
      items: [{ id: item.id, price: price.id }],
      proration_behavior: "none",
      metadata: { plan_key: plan.key },
    });
  } catch (error) {
    console.error("[growth] plan change failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "We could not change your plan just now. Nothing was charged." };
  }

  const [row] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, plan.key)).limit(1);
  if (row) {
    await db
      .update(subscriptions)
      .set({ planId: row.id, monthlyPriceCents: price.unit_amount ?? plan.monthlyCents })
      .where(eq(subscriptions.id, sub.id));
  }
  await audit(db, ctx, "growth.plan_changed", { plan: plan.key });

  return {
    ok: true,
    message: `You are on ${plan.name} now. Your next payment is at the new price.`,
  };
}

/** Schedule a cancellation at the end of the paid period, or undo one. */
export async function setPlanCancellation(
  db: Database,
  ctx: TenantContext,
  cancel: boolean,
): Promise<ChangeResult> {
  assertMutable(ctx);
  if (!stripeConfigured()) return NOT_SELF_SERVE;
  const sub = await stripeSubscriptionFor(db, ctx);
  if (!sub) return NOT_SELF_SERVE;

  try {
    await requireStripe().subscriptions.update(sub.providerSubscriptionId, {
      cancel_at_period_end: cancel,
    });
  } catch (error) {
    console.error("[growth] cancellation change failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "We could not change that just now. Please try again." };
  }
  await db.update(subscriptions).set({ cancelAtPeriodEnd: cancel }).where(eq(subscriptions.id, sub.id));
  await audit(db, ctx, cancel ? "growth.plan_cancel_scheduled" : "growth.plan_cancel_undone", {});

  return cancel
    ? {
        ok: true,
        message:
          "Your plan will end at the close of the period you have paid for. Your website stays online; changes and Growth tools stop then.",
      }
    : { ok: true, message: "Cancellation undone. Your plan carries on as before." };
}
