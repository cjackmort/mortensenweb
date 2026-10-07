import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";

import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  payments,
  subscriptions,
  webhookDeliveries,
} from "@/db/schema";
import {
  collectedCents,
  portalStatusFor,
  requireStripe,
  stripeConfigured,
} from "@/lib/payments/stripe";
import { SUBSCRIPTION_EXPAND } from "@/lib/payments/promos";
import { formatCurrency } from "@/lib/payments/venmo";
import {
  applyPaidInvoice,
  invoiceMetadata,
  matchClient,
  mirrorSubscription,
} from "./stripe-webhooks";

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
 * whose status drifted, a paid-through date behind Stripe's, and, the one
 * that matters most, a subscription or a settled invoice whose event never
 * arrived. Those last two are repaired by calling the receiver's own
 * functions with the receiver's own tenant match (`matchClient`), so a
 * repaired payment is exactly what a delivered `invoice.paid` would have
 * produced, and the job trusts no evidence the receiver would not.
 *
 * That last part used to be flag-only, with a note to replay the event from
 * the Stripe dashboard. Nobody reads that note in time: when the signing
 * secret on Netlify did not match the endpoint, every delivery answered 401,
 * the first real payment never reached the portal, and this job recorded
 * "missing_payment" in an audit row that nothing displayed. A net that only
 * reports is not a net.
 *
 * It flags rather than repairs anything where being wrong causes harm: a
 * Stripe customer no local client claims (or two clients both do), a local
 * subscription Stripe has never heard of, an amount that disagrees. Those go
 * to an operator, because the automated repair for each of them is a guess
 * about whose money this is.
 *
 * It never changes a complimentary client's plan, and it never removes
 * access. A comp client whom Stripe is still charging is flagged: one of the
 * two is a mistake, and only the operator knows which.
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
    | "missing_subscription"
    | "comp_billed"
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

/** Stripe statuses under which the card will be charged again. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

function compBilled(clientId: string, sub: Stripe.Subscription): ReconcileFinding {
  const price = sub.items.data[0]?.price;
  const amount = price?.unit_amount
    ? `${formatCurrency(price.unit_amount, (price.currency ?? "usd").toUpperCase())} a month`
    : "every period";
  return {
    kind: "comp_billed",
    repaired: false,
    clientId,
    reference: sub.id,
    detail: `This client is on a complimentary plan, but Stripe subscription ${sub.id} is ${sub.status} and will keep charging their card ${amount}. Cancel it in Stripe, or withdraw the comp.`,
  };
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
      const charging = LIVE_STATUSES.has(sub.status);

      if (!row) {
        // Stripe has a subscription we have no record of: its events were
        // missed. Mirrored only when the receiver itself would have matched it
        // to a tenant; otherwise flagged, because choosing a tenant here would
        // grant a stranger someone else's account.
        const match = await matchClient(db, { metadata: sub.metadata, customerId });

        if (!match) {
          findings.push({
            kind: "unclaimed_customer",
            repaired: false,
            clientId: null,
            reference: sub.id,
            detail: `Stripe subscription ${sub.id} belongs to customer ${customerId}, which no client claims (or two clients do).`,
          });
          continue;
        }

        const fresh = await stripe.subscriptions.retrieve(sub.id, {
          expand: SUBSCRIPTION_EXPAND,
        });
        const mirrored = await mirrorSubscription(
          db,
          match.clientId,
          match.organizationId,
          fresh,
        );

        if (mirrored === "mirrored") {
          findings.push({
            kind: "missing_subscription",
            repaired: true,
            clientId: match.clientId,
            reference: sub.id,
            detail: `Stripe subscription ${sub.id} (${fresh.status}) had never reached the portal; mirrored it.`,
          });
        } else if (charging) {
          findings.push(compBilled(match.clientId, sub));
        }
        continue;
      }

      // A comp client's settings are the operator's. Never reconciled over,
      // but a card still being charged is something they need to know about.
      if (row.compPlanId) {
        if (charging) findings.push(compBilled(row.clientId, sub));
        continue;
      }

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

      // A settled invoice with no ledger row is the signature of a missed
      // webhook. Recorded through the receiver's own `applyPaidInvoice`, so
      // the ledger row, the subscription mirror and the unlock all happen
      // together, exactly as a delivered event would have done them.
      const match = await matchClient(db, {
        metadata: invoiceMetadata(invoice),
        customerId,
      });

      if (!match) {
        findings.push({
          kind: "missing_payment",
          repaired: false,
          clientId: null,
          reference: invoice.id,
          detail: `Invoice ${invoice.id} settled for customer ${customerId ?? "unknown"}, which no client claims (or two clients do).`,
        });
        continue;
      }

      await applyPaidInvoice(db, match, invoice, "stripe_reconcile");
      findings.push({
        kind: "missing_payment",
        repaired: true,
        clientId: match.clientId,
        reference: invoice.id,
        detail: `Invoice ${invoice.id} (${formatCurrency(collectedCents(invoice), (invoice.currency ?? "usd").toUpperCase())}) was settled at Stripe, but its webhook never arrived. Recorded it.`,
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
 * How often a scheduled pass is worth doing.
 *
 * The cron tick runs every few minutes because the jobs beside this one are
 * about a client waiting. Reconciliation is not: it is a net for lost
 * webhooks, and webhooks are retried by Stripe for three days on their own.
 * Running a full comparison every tick would burn rate limit to discover
 * nothing, so it runs at most hourly and the retries cover the gap.
 *
 * "At most": the cron endpoint skips ticks entirely while the portal is idle
 * (`lib/scheduler/gate.ts`), so on a quiet day this runs with the six-hourly
 * sweep. Three days of Stripe retries cover that comfortably too.
 */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

export type ScheduledReconcileResult =
  | { ran: false; reason: "not_configured" | "too_soon" }
  | ({ ran: true } & ReconcileResult);

/**
 * The scheduled entry point.
 *
 * Gated on when the last pass finished, which is read from `audit_log` rather
 * than held in memory — a serverless function does not survive between ticks,
 * so an in-process timestamp would gate nothing and this would run every time.
 *
 * That same row is the persisted result: what was checked, what was repaired,
 * and what needs a human. `reconcileStripe` reports a failure as a failure, and
 * this records it as one, so a run that could not reach Stripe is visible
 * afterwards instead of looking like a clean pass with nothing to report.
 *
 * ## On overlapping runs
 *
 * The interval gate is what keeps two passes apart, and it is not a lock: two
 * ticks landing in the same instant could both read a stale timestamp and both
 * proceed. That is tolerable here and would not be if the work were not
 * idempotent — every write this job makes sets a value read from Stripe, so a
 * duplicate pass writes the same values a second time and changes nothing. It
 * is wasteful, not harmful. A real lock would be worth adding if this ever
 * grew a non-idempotent step.
 */
export async function runScheduledReconcile(
  db: Database,
): Promise<ScheduledReconcileResult> {
  if (!stripeConfigured()) return { ran: false, reason: "not_configured" };

  const since = new Date(Date.now() - RECONCILE_INTERVAL_MS);
  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "stripe.reconciled"),
        gte(auditLog.createdAt, since),
      ),
    )
    .limit(1);

  if (recent.length > 0) return { ran: false, reason: "too_soon" };

  const result = await reconcileStripe(db);

  await db.insert(auditLog).values({
    action: "stripe.reconciled",
    entityType: "stripe",
    entityId: null,
    metadata: {
      ok: result.ok,
      error: result.error,
      checkedSubscriptions: result.checkedSubscriptions,
      checkedInvoices: result.checkedInvoices,
      repaired: result.findings.filter((f) => f.repaired).length,
      needsReview: result.findings.filter((f) => !f.repaired).length,
      // Bounded so one bad pass cannot write an unbounded blob into the log.
      findings: result.findings.slice(0, 50),
    },
  });

  return { ran: true, ...result };
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
      // What is actually charged: the promo price while a promo runs. The
      // same rule as `effectiveMonthlyCents`, in SQL.
      total: sql<number>`coalesce(sum(
        CASE WHEN ${subscriptions.discountedPriceCents} IS NOT NULL
              AND (${subscriptions.discountEndsAt} IS NULL OR ${subscriptions.discountEndsAt} > now())
             THEN ${subscriptions.discountedPriceCents}
             ELSE ${subscriptions.monthlyPriceCents} END
      ), 0)::int`,
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

/**
 * What the operator needs to know about the Stripe sync, for the payments page.
 *
 * Before this, the reconciliation job's findings lived only in `audit_log`, and
 * nothing displayed them. The first real payment never reached the portal, the
 * job noticed within the hour, and the only person who could act on it had no
 * way of finding out.
 *
 * `recoveredRecently` is the signal that outlives one run. A run that repairs
 * a missed payment finds nothing next hour, so the latest run alone would show
 * the problem for an hour at most; a count of payments that arrived only
 * through the net keeps showing that webhooks are not getting through until
 * they are.
 */
export interface StripeSyncStatus {
  lastRunAt: Date | null;
  ok: boolean;
  error: string | null;
  needsReview: ReconcileFinding[];
  repaired: ReconcileFinding[];
  /** Payments recorded by the job, not a webhook, since the last processed delivery (30 days at most). */
  recoveredRecently: number;
}

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function stripeSyncStatus(db: Database): Promise<StripeSyncStatus> {
  const latest = await db
    .select({ createdAt: auditLog.createdAt, metadata: auditLog.metadata })
    .from(auditLog)
    .where(eq(auditLog.action, "stripe.reconciled"))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  // A delivery Stripe got a 2xx for after the last recovery proves the
  // webhook path works again, so earlier recoveries stop counting.
  const lastDelivery = await db
    .select({ receivedAt: webhookDeliveries.receivedAt })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.provider, "stripe"),
        eq(webhookDeliveries.signatureValid, true),
        eq(webhookDeliveries.status, "processed"),
      ),
    )
    .orderBy(desc(webhookDeliveries.receivedAt))
    .limit(1);

  const windowStart = new Date(Date.now() - RECOVERY_WINDOW_MS);
  const since =
    lastDelivery[0] && lastDelivery[0].receivedAt > windowStart
      ? lastDelivery[0].receivedAt
      : windowStart;

  const recovered = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "payment.recorded"),
        sql`${auditLog.metadata}->>'source' = 'stripe_reconcile'`,
        gte(auditLog.createdAt, since),
      ),
    );

  const meta = (latest[0]?.metadata ?? {}) as {
    ok?: boolean;
    error?: string | null;
    findings?: ReconcileFinding[];
  };
  const findings = Array.isArray(meta.findings) ? meta.findings : [];

  return {
    lastRunAt: latest[0]?.createdAt ?? null,
    ok: latest[0] ? meta.ok === true : true,
    error: meta.error ?? null,
    needsReview: findings.filter((f) => !f.repaired),
    repaired: findings.filter((f) => f.repaired),
    recoveredRecently: Number(recovered[0]?.count ?? 0),
  };
}
