import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, payments, servicePlans, subscriptions } from "@/db/schema";
import {
  billingStatusFor,
  type BillingStatus,
} from "@/lib/billing/stripe-status";
import { stripeConfigured } from "@/lib/payments/stripe";
import type { TenantContext } from "../context";

/**
 * What the billing page shows about a card subscription.
 *
 * Read entirely from the local mirror — no Stripe call happens when this page
 * renders. Two reasons: a billing page that fetches from a third party is as
 * slow and as available as that third party, and a client looking at a year of
 * receipts should not depend on Stripe being up to see them. The mirror is
 * kept current by the webhook, and the reconciliation job catches what the
 * webhook misses.
 *
 * The one thing this deliberately does *not* do is infer. If there is no
 * settled invoice, the status says so rather than assuming the subscription
 * being active means somebody paid.
 */

export interface StripePaymentRow {
  publicId: string;
  amountCents: number;
  currency: string;
  receivedOn: string;
  /** Stripe's hosted invoice page. Null for cash, Venmo and cheques. */
  receiptUrl: string | null;
  /** False for a settlement that collected nothing — credit, or a zero total. */
  collectedCash: boolean;
}

export interface StripeBillingPanel {
  /** False when Stripe has no credentials here; the page hides the panel. */
  available: boolean;
  status: BillingStatus;
  planName: string | null;
  /** What they are billed each period, in cents. Null when not subscribed. */
  monthlyPriceCents: number | null;
  currency: string;
  /** End of the period the last settled invoice covers. */
  paidThrough: Date | null;
  /**
   * When the next charge is expected, and for how much.
   *
   * Null while a cancellation is scheduled — there is no next charge, and
   * showing one would contradict the cancellation notice beside it.
   */
  nextChargeOn: Date | null;
  nextChargeCents: number | null;
  history: StripePaymentRow[];
  /** Whether to offer the Stripe Customer Portal button. */
  canManage: boolean;
}

export async function getStripeBillingPanel(
  db: Database,
  ctx: TenantContext,
): Promise<StripeBillingPanel> {
  const rows = await db
    .select({
      clientId: clients.id,
      compPlanId: clients.compPlanId,
      stripeCustomerId: clients.stripeCustomerId,
      planName: servicePlans.name,
      monthlyPriceCents: subscriptions.monthlyPriceCents,
      currency: subscriptions.currency,
      providerStatus: subscriptions.providerStatus,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(clients)
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.provider, "stripe"),
        // A cancelled subscription is still shown, so somebody who cancelled
        // last month can still reach their receipts.
        sql`${subscriptions.status} <> 'paused'`,
      ),
    )
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const row = rows[0];

  if (!row) {
    return {
      available: false,
      status: billingStatusFor({
        compPlanId: null,
        providerStatus: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        hasSettledInvoice: false,
      }),
      planName: null,
      monthlyPriceCents: null,
      currency: "USD",
      paidThrough: null,
      nextChargeOn: null,
      nextChargeCents: null,
      history: [],
      canManage: false,
    };
  }

  // Only Stripe rows, and only ones that actually collected. A zero-collection
  // settlement is recorded in the ledger for completeness but is not a payment
  // this client made, and listing it under "payments" would be a lie in the
  // client's favour that they would notice at the wrong moment.
  const historyRows = await db
    .select({
      publicId: payments.publicId,
      amountCents: payments.amountCents,
      currency: payments.currency,
      receivedOn: payments.receivedOn,
      receiptUrl: payments.receiptUrl,
    })
    .from(payments)
    .where(
      and(
        eq(payments.clientId, row.clientId),
        eq(payments.provider, "stripe"),
        eq(payments.status, "recorded"),
      ),
    )
    .orderBy(desc(payments.receivedOn))
    .limit(24);

  const settled = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.clientId, row.clientId),
        eq(payments.provider, "stripe"),
        eq(payments.status, "recorded"),
        gt(payments.amountCents, 0),
      ),
    );

  const hasSettledInvoice = (settled[0]?.count ?? 0) > 0;

  const status = billingStatusFor({
    compPlanId: row.compPlanId,
    providerStatus: row.providerStatus,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: row.currentPeriodEnd,
    hasSettledInvoice,
  });

  // No next charge when the subscription is ending, or when there is nothing
  // active to charge. Showing a date beside "cancels at period end" would
  // contradict it.
  const willRenew =
    status.state === "paid" ||
    status.state === "processing" ||
    status.state === "action_required";

  return {
    available: stripeConfigured(),
    status,
    planName: row.planName,
    monthlyPriceCents: row.monthlyPriceCents,
    currency: row.currency ?? "USD",
    paidThrough: hasSettledInvoice ? row.currentPeriodEnd : null,
    nextChargeOn: willRenew ? row.currentPeriodEnd : null,
    nextChargeCents: willRenew ? row.monthlyPriceCents : null,
    history: historyRows.map((p) => ({
      publicId: p.publicId,
      amountCents: p.amountCents,
      currency: p.currency,
      receivedOn: p.receivedOn,
      receiptUrl: p.receiptUrl,
      collectedCash: p.amountCents > 0,
    })),
    // Only offered when there is a customer to open a portal for. A comp
    // client has no billing to manage and must not be shown a button that
    // implies they are being charged.
    canManage:
      stripeConfigured() &&
      Boolean(row.stripeCustomerId) &&
      !row.compPlanId,
  };
}
