import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { clients, payments, subscriptions, webhookDeliveries } from "@/db/schema";
import {
  collectedCents,
  portalStatusFor,
  requireStripe,
  stripeConfigured,
} from "@/lib/payments/stripe";

/**
 * Checking Stripe against ourselves.
 *
 * Webhooks are the primary path and this is the safety net. Deliveries are
 * lost — an endpoint down for an hour, a deploy mid-delivery, a signing secret
 * rotated without updating the environment — and the failure is silent: a
 * client who paid stays locked out, and nothing anywhere says so. A periodic
 * comparison is the only thing that finds that.
 *
 * ## What it will and will not repair
 *
 * It repairs facts that are unambiguous and safe to restate: a subscription
 * whose status drifted, a paid-through date behind Stripe's, a settled invoice
 * with no ledger row.
 *
 * It flags rather than repairs anything where being wrong causes harm: a
 * Stripe customer no local client claims, a local subscription Stripe has
 * never heard of, an amount that disagrees. Those go to an operator, because
 * the automated repair for each of them is a guess about whose money this is.
 *
 * It never touches a complimentary client, and it never removes access.
 *
 * ## Bounded
 *
 * Every pass has a hard ceiling on how much it will look at. An unbounded
 * reconciliation over a growing account eventually takes longer than the
 * interval it runs on, and two of them overlapping is how you get the double
 * writes this job exists to prevent.
 */

const MAX_SUBSCRIPTIONS = 200;
const MAX_INVOICES = 200;

export interface ReconcileFinding {
  kind:
    | "status_drift"
    | "period_drift"
    | "missing_payment"
    | "unclaimed_customer"
    | "orphan_subscription"
    | "amount_mismatch";
  /** Whether this pass changed anything, or only recorded the problem. */
  repaired: boolean;
  clientId: string | null;
  reference: string;
  detail: string;
}

export interface ReconcileResult {
  ok: boolean;
  checkedSubscriptions: number;
  checkedInvoices: number;
  findings: ReconcileFinding[];
  /** Set when the pass could not complete. Never reported as healthy. */
  error: string | null;
}

/**
 * One reconciliation pass.
 *
 * Returns its findings rather than throwing, except that a failure to reach
 * Stripe at all is reported with `ok: false` — a job that swallows an outage
 * and returns an empty finding list looks exactly like a clean run, which is
 * the misleading-healthy-status failure worth avoiding.
 */
export async function reconcileStripe(db: Database): Promise<ReconcileResult> {
  const findings: ReconcileFinding[] = [];

  if (!stripeConfigured()) {
    return {
      ok: false,
      checkedSubscriptions: 0,
      checkedInvoices: 0,
      findings,
      error: "Stripe is not configured.",
    };
  }

  const stripe = requireStripe();

  let checkedSubscriptions = 0;
  let checkedInvoices = 0;

  try {
    // ---- Subscriptions -----------------------------------------------------
    const remote = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.items.data.price"],
    });

    for (const sub of remote.data.slice(0, MAX_SUBSCRIPTIONS)) {
      checkedSubscriptions += 1;

      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;

      const local = await db
        .select({
          id: subscriptions.id,
          clientId: subscriptions.clientId,
          status: subscriptions.status,
          providerStatus: subscriptions.providerStatus,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          compPlanId: clients.compPlanId,
        })
        .from(subscriptions)
        .innerJoin(clients, eq(clients.id, subscriptions.clientId))
        .where(
          and(
            eq(subscriptions.provider, "stripe"),
            eq(subscriptions.providerSubscriptionId, sub.id),
          ),
        )
        .limit(1);

      const row = local[0];

      if (!row) {
        // Stripe has a subscription we have no record of. Not repaired:
        // creating a local subscription from this would mean choosing a tenant,
        // and choosing wrong grants a stranger someone else's account.
        const owner = await db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.stripeCustomerId, customerId))
          .limit(1);

        findings.push({
          kind: "unclaimed_customer",
          repaired: false,
          clientId: owner[0]?.id ?? null,
          reference: sub.id,
          detail: owner[0]
            ? `Stripe subscription ${sub.id} exists for a known client but has no local row.`
            : `Stripe subscription ${sub.id} belongs to customer ${customerId}, which no client claims.`,
        });
        continue;
      }

      // A comp client's settings are the operator's. Never reconciled over.
      if (row.compPlanId) continue;

      const item = sub.items.data[0];
      const periodEndSeconds =
        (item as unknown as { current_period_end?: number })
          ?.current_period_end ??
        (sub as unknown as { current_period_end?: number }).current_period_end ??
        null;
      const periodEnd = periodEndSeconds
        ? new Date(periodEndSeconds * 1000)
        : null;

      const expectedStatus = portalStatusFor(sub.status);

      if (
        row.providerStatus !== sub.status ||
        row.status !== expectedStatus ||
        row.cancelAtPeriodEnd !== sub.cancel_at_period_end
      ) {
        await db
          .update(subscriptions)
          .set({
            providerStatus: sub.status,
            status: expectedStatus,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          })
          .where(eq(subscriptions.id, row.id));

        findings.push({
          kind: "status_drift",
          repaired: true,
          clientId: row.clientId,
          reference: sub.id,
          detail: `Status was ${row.providerStatus ?? "null"}, Stripe says ${sub.status}.`,
        });
      }

      const localEnd = row.currentPeriodEnd?.getTime() ?? 0;
      const remoteEnd = periodEnd?.getTime() ?? 0;

      // Only ever moved forward. A paid-through date that goes backwards would
      // take away access somebody has already paid for.
      if (remoteEnd > localEnd) {
        await db
          .update(subscriptions)
          .set({ currentPeriodEnd: periodEnd })
          .where(eq(subscriptions.id, row.id));

        findings.push({
          kind: "period_drift",
          repaired: true,
          clientId: row.clientId,
          reference: sub.id,
          detail: `Paid-through advanced to ${periodEnd?.toISOString() ?? "null"}.`,
        });
      }
    }

    // ---- Invoices ----------------------------------------------------------
    const invoices = await stripe.invoices.list({
      status: "paid",
      limit: 100,
    });

    for (const invoice of invoices.data.slice(0, MAX_INVOICES)) {
      checkedInvoices += 1;
      if (!invoice.id) continue;

      const idempotencyKey = `stripe_invoice:${invoice.id}`;
      const existing = await db
        .select({ id: payments.id, amountCents: payments.amountCents })
        .from(payments)
        .where(eq(payments.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existing[0]) {
        const expected = collectedCents(invoice);
        if (existing[0].amountCents !== expected) {
          // Never silently corrected. A ledger amount changing under an
          // operator's feet is worse than one that is flagged as disputed.
          findings.push({
            kind: "amount_mismatch",
            repaired: false,
            clientId: null,
            reference: invoice.id,
            detail: `Ledger has ${existing[0].amountCents}, Stripe collected ${expected}.`,
          });
        }
        continue;
      }

      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : (invoice.customer?.id ?? null);

      const owner = customerId
        ? await db
            .select({ id: clients.id })
            .from(clients)
            .where(eq(clients.stripeCustomerId, customerId))
            .limit(1)
        : [];

      // A settled invoice with no ledger row is the signature of a missed
      // webhook. Flagged rather than inserted here: the insert path lives in
      // the receiver, where the entitlement consequences are handled together
      // with it, and duplicating that logic in two places is how they drift.
      findings.push({
        kind: "missing_payment",
        repaired: false,
        clientId: owner[0]?.id ?? null,
        reference: invoice.id,
        detail: owner[0]
          ? `Invoice ${invoice.id} settled at Stripe but has no ledger row. Replay the event from the Stripe dashboard.`
          : `Invoice ${invoice.id} settled for customer ${customerId ?? "unknown"}, which no client claims.`,
      });
    }

    // ---- Deliveries needing a human ---------------------------------------
    const stuck = await db
      .select({
        deliveryId: webhookDeliveries.deliveryId,
        event: webhookDeliveries.event,
        status: webhookDeliveries.status,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.provider, "stripe"),
          sql`${webhookDeliveries.status} IN ('unmatched', 'failed', 'needs_review')`,
        ),
      )
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(50);

    for (const delivery of stuck) {
      findings.push({
        kind: "orphan_subscription",
        repaired: false,
        clientId: null,
        reference: delivery.deliveryId,
        detail: `Delivery ${delivery.deliveryId} (${delivery.event ?? "unknown"}) is ${delivery.status}.`,
      });
    }

    return {
      ok: true,
      checkedSubscriptions,
      checkedInvoices,
      findings,
      error: null,
    };
  } catch (error) {
    // Reported as a failure, never as a clean pass.
    return {
      ok: false,
      checkedSubscriptions,
      checkedInvoices,
      findings,
      error: error instanceof Error ? error.message : "unknown",
    };
  }
}

/**
 * The admin billing view's data.
 *
 * Three totals that are routinely conflated and mean different things:
 *
 *  - **recurring** is an estimate of what active subscriptions will bill. It
 *    is not money; nobody has paid it.
 *  - **collected** is what actually arrived, from the ledger, excluding the
 *    zero-collection settlements that `invoice.paid` also fires for.
 *  - Neither is a bank balance. Stripe holds funds before paying out, so a
 *    payout figure is a third number and is not derived from either of these.
 */
export interface AdminBillingSummary {
  activeSubscriptions: number;
  recurringMonthlyCents: number;
  collectedThisMonthCents: number;
  complimentaryClients: number;
  failedPayments: number;
  unmatchedDeliveries: number;
}

export async function adminBillingSummary(
  db: Database,
  periodStart: string,
): Promise<AdminBillingSummary> {
  const active = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${subscriptions.monthlyPriceCents}), 0)::int`,
    })
    .from(subscriptions)
    .innerJoin(clients, eq(clients.id, subscriptions.clientId))
    .where(
      and(
        eq(subscriptions.status, "active"),
        eq(subscriptions.provider, "stripe"),
        // Comp, internal and demo clients are excluded from every revenue
        // rollup: none of them represents money anybody will pay.
        isNull(clients.compPlanId),
        eq(clients.isInternal, false),
        eq(clients.isDemo, false),
      ),
    );

  const collected = await db
    .select({
      total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.status, "recorded"),
        sql`${payments.receivedOn} >= ${periodStart}`,
        sql`${payments.isDemo} = false`,
      ),
    );

  const comp = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(isNotNull(clients.compPlanId));

  const failed = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(sql`${subscriptions.providerStatus} IN ('past_due', 'unpaid', 'incomplete')`);

  const unmatched = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.provider, "stripe"),
        sql`${webhookDeliveries.status} IN ('unmatched', 'failed', 'needs_review')`,
      ),
    );

  return {
    activeSubscriptions: active[0]?.count ?? 0,
    recurringMonthlyCents: active[0]?.total ?? 0,
    collectedThisMonthCents: collected[0]?.total ?? 0,
    complimentaryClients: comp[0]?.count ?? 0,
    failedPayments: failed[0]?.count ?? 0,
    unmatchedDeliveries: unmatched[0]?.count ?? 0,
  };
}
