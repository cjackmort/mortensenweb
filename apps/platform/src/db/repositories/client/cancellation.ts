import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { GROWTH_FEATURES, type GrowthFeatureKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { clientAddOns, clients, servicePlans, subscriptions, users } from "@/db/schema";
import { portalOrigin } from "@/lib/auth/reset";
import { buildCancellationEmail } from "@/lib/email/cancellation";
import { sendEmail } from "@/lib/email/mailer";
import { planItemOf, priceForAddOn, requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { formatDate } from "@/lib/time";
import { assertMutable, type TenantContext } from "../context";
import {
  audit,
  clientIdFor,
  NOT_SELF_SERVE,
  stripeSubscriptionFor,
  type ChangeResult,
  type StripeSubscriptionRow,
} from "./growth";

/**
 * Cancelling from the Plan tab, and undoing it.
 *
 * One click, no confirm dialog: cancelling must be no harder than signing up
 * (the US "click-to-cancel" expectation), and the page answers with
 * "Ends <date> · Undo" instead of asking first. Both kinds of cancel keep
 * everything working until the end of the period already paid for:
 *
 * - **The plan** is `cancel_at_period_end` on the subscription. Stripe ends
 *   it, add-ons included, at the period end and charges nothing more.
 * - **One add-on** is deleted from the subscription with no proration: the
 *   next payment leaves it out, and nothing is refunded or charged now.
 *   `client_add_ons.cancels_at` keeps the feature working in the portal until
 *   that period ends. Stripe has no per-line "cancel at period end"; a
 *   subscription schedule could stage one, but a schedule then owns every
 *   later change to the subscription, which the plan changes here do not
 *   expect. Undo puts the line back, again with no proration, because the
 *   days left were already paid for.
 *
 * A subscription must keep one line, so an add-on that is the only line is
 * cancelled the way a plan is.
 *
 * Every cancel emails a confirmation — what ends, when, and how to undo —
 * and is in the audit log, so there is a record of it besides the client's
 * memory.
 */

function fromSeconds(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/** When the period a line has been paid for ends. On the item since the 2025 API versions. */
function periodEndOf(item: Stripe.SubscriptionItem | undefined, subscription?: Stripe.Subscription): Date | null {
  const fromItem = (item as unknown as { current_period_end?: number } | undefined)?.current_period_end;
  const fromSub = (subscription as unknown as { current_period_end?: number } | undefined)?.current_period_end;
  return fromSeconds(fromItem ?? fromSub);
}

function failed(): ChangeResult {
  return { ok: false, message: "We could not change that just now. Nothing has changed. Please try again." };
}

function featureName(key: string): string {
  return GROWTH_FEATURES.find((f) => f.key === key)?.name ?? "That add-on";
}

async function planNameOf(db: Database, subscriptionId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: servicePlans.name })
    .from(subscriptions)
    .innerJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * The confirmation email, to the person who cancelled. Never allowed to fail
 * the cancellation: it has already happened at Stripe, and the outcome of the
 * send is recorded either way.
 */
async function confirmCancellation(
  db: Database,
  ctx: TenantContext,
  input: { what: string; wholePlan: boolean; endsOn: Date | null },
): Promise<void> {
  const [who] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  const [client] = await db
    .select({ name: clients.primaryContactName, email: clients.primaryContactEmail })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  const to = who?.email ?? client?.email ?? null;

  let status: string = "no_recipient";
  if (to) {
    try {
      const message = buildCancellationEmail({
        contactName: client?.name ?? null,
        what: input.what,
        wholePlan: input.wholePlan,
        endsOn: input.endsOn,
        planUrl: `${portalOrigin()}/dashboard/plan`,
      });
      status = (await sendEmail({ ...message, to })).status;
    } catch (error) {
      status = "failed";
      console.error("[cancel] confirmation email failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }

  await audit(db, ctx, "growth.cancellation_emailed", { what: input.what, status });
}

/** Cancel the plan at the end of the paid period, or undo that. */
export async function setPlanCancellation(
  db: Database,
  ctx: TenantContext,
  cancel: boolean,
): Promise<ChangeResult> {
  assertMutable(ctx);
  if (!stripeConfigured()) return NOT_SELF_SERVE;
  const sub = await stripeSubscriptionFor(db, ctx);
  if (!sub) return NOT_SELF_SERVE;

  let updated: Stripe.Subscription;
  try {
    updated = await requireStripe().subscriptions.update(sub.providerSubscriptionId, {
      cancel_at_period_end: cancel,
    });
  } catch (error) {
    console.error("[cancel] plan cancellation change failed", { message: error instanceof Error ? error.message : "unknown" });
    return failed();
  }

  const endsOn = periodEndOf(planItemOf(updated), updated) ?? sub.currentPeriodEnd;
  await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: cancel, ...(endsOn ? { currentPeriodEnd: endsOn } : {}) })
    .where(eq(subscriptions.id, sub.id));
  await audit(db, ctx, cancel ? "growth.plan_cancel_scheduled" : "growth.plan_cancel_undone", {
    endsOn: endsOn?.toISOString() ?? null,
  });

  if (!cancel) return { ok: true, message: "Undone. Your plan carries on as before." };

  const name = await planNameOf(db, sub.id);
  await confirmCancellation(db, ctx, { what: name ? `${name} plan` : "your plan", wholePlan: true, endsOn });
  return {
    ok: true,
    message: endsOn ? `Cancelled. Your plan ends on ${formatDate(endsOn)}.` : "Cancelled. Your plan ends at the close of this period.",
  };
}

async function liveStripeAddOn(db: Database, clientId: string, featureKey: string) {
  const [row] = await db
    .select({
      id: clientAddOns.id,
      source: clientAddOns.source,
      item: clientAddOns.stripeSubscriptionItemId,
      cancelsAt: clientAddOns.cancelsAt,
    })
    .from(clientAddOns)
    .where(and(eq(clientAddOns.clientId, clientId), eq(clientAddOns.featureKey, featureKey), isNull(clientAddOns.endedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Stop paying for one add-on from the next payment, keeping it until then.
 * A second click is answered as success: it is already cancelled.
 */
export async function cancelGrowthAddOn(
  db: Database,
  ctx: TenantContext,
  featureKey: string,
): Promise<ChangeResult> {
  assertMutable(ctx);
  const clientId = await clientIdFor(db, ctx);
  if (!clientId) return NOT_SELF_SERVE;
  const row = await liveStripeAddOn(db, clientId, featureKey);
  const name = featureName(featureKey);
  if (!row || (row.cancelsAt && row.cancelsAt <= new Date())) {
    return { ok: false, message: "You do not have that add-on." };
  }
  // One the operator granted is theirs to take away, not a line on the
  // client's card the client can cancel.
  if (row.source !== "stripe" || !row.item) return NOT_SELF_SERVE;
  if (row.cancelsAt) return { ok: true, message: `${name} is already cancelled. It ends on ${formatDate(row.cancelsAt)}.` };

  if (!stripeConfigured()) return NOT_SELF_SERVE;
  const sub = await stripeSubscriptionFor(db, ctx);
  if (!sub) return NOT_SELF_SERVE;

  let endsOn: Date | null;
  let wholeSubscription = false;
  try {
    const stripe = requireStripe();
    const live = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
    const items = live.items?.data ?? [];
    endsOn = periodEndOf(items.find((i) => i.id === row.item), live) ?? sub.currentPeriodEnd;
    wholeSubscription = items.length > 0 && items.every((i) => i.id === row.item);
    if (wholeSubscription) {
      await stripe.subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true });
    } else {
      await stripe.subscriptionItems.del(row.item, { proration_behavior: "none" });
    }
  } catch (error) {
    console.error("[cancel] add-on cancellation failed", { message: error instanceof Error ? error.message : "unknown" });
    return failed();
  }

  const now = new Date();
  const cancelsAt = endsOn && endsOn > now ? endsOn : now;
  await db.update(clientAddOns).set({ cancelsAt, updatedAt: now }).where(eq(clientAddOns.id, row.id));
  if (wholeSubscription) {
    await db.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, sub.id));
  }
  await audit(db, ctx, "growth.add_on_cancelled", {
    feature: featureKey,
    item: row.item,
    endsOn: cancelsAt.toISOString(),
    wholeSubscription,
  });
  await confirmCancellation(db, ctx, { what: name, wholePlan: false, endsOn: cancelsAt });

  return { ok: true, message: `Cancelled. ${name} ends on ${formatDate(cancelsAt)}.` };
}

/** Undo an add-on cancellation while the period it was paid for still runs. */
export async function undoAddOnCancellation(
  db: Database,
  ctx: TenantContext,
  featureKey: string,
): Promise<ChangeResult> {
  assertMutable(ctx);
  const clientId = await clientIdFor(db, ctx);
  if (!clientId) return NOT_SELF_SERVE;
  const [row] = await db
    .select({ id: clientAddOns.id, item: clientAddOns.stripeSubscriptionItemId })
    .from(clientAddOns)
    .where(
      and(
        eq(clientAddOns.clientId, clientId),
        eq(clientAddOns.featureKey, featureKey),
        eq(clientAddOns.source, "stripe"),
        isNull(clientAddOns.endedAt),
        isNotNull(clientAddOns.cancelsAt),
        gt(clientAddOns.cancelsAt, new Date()),
      ),
    )
    .limit(1);
  const name = featureName(featureKey);
  if (!row) return { ok: false, message: `${name} has already ended. You can add it again below.` };

  if (!stripeConfigured()) return NOT_SELF_SERVE;
  const sub = await stripeSubscriptionFor(db, ctx);
  if (!sub) return NOT_SELF_SERVE;

  const restored = await restoreLine(sub, featureKey as GrowthFeatureKey, row.item);
  if (!restored) return failed();

  await db
    .update(clientAddOns)
    .set({ cancelsAt: null, stripeSubscriptionItemId: restored.itemId, updatedAt: new Date() })
    .where(eq(clientAddOns.id, row.id));
  if (restored.wholeSubscription) {
    await db.update(subscriptions).set({ cancelAtPeriodEnd: false }).where(eq(subscriptions.id, sub.id));
  }
  await audit(db, ctx, "growth.add_on_cancel_undone", { feature: featureKey, item: restored.itemId });

  return { ok: true, message: `Undone. ${name} carries on as before.` };
}

/**
 * Put the line back at Stripe. When it was the subscription's only line it
 * was never removed — the subscription was set to end — so that is undone
 * instead. No proration either way: the rest of this period is paid for.
 */
async function restoreLine(
  sub: StripeSubscriptionRow,
  featureKey: GrowthFeatureKey,
  itemId: string | null,
): Promise<{ itemId: string; wholeSubscription: boolean } | null> {
  try {
    const stripe = requireStripe();
    const live = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
    if (itemId && (live.items?.data ?? []).some((i) => i.id === itemId)) {
      await stripe.subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: false });
      return { itemId, wholeSubscription: true };
    }
    const price = await priceForAddOn(featureKey);
    if (!price) return null;
    const item = await stripe.subscriptionItems.create({
      subscription: sub.providerSubscriptionId,
      price: price.id,
      proration_behavior: "none",
      metadata: { growth_feature: featureKey },
    });
    return { itemId: item.id, wholeSubscription: false };
  } catch (error) {
    console.error("[cancel] undo failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

