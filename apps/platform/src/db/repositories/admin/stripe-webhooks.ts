import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  payments,
  servicePlans,
  subscriptions,
  webhookDeliveries,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { businessDate } from "@/lib/billing/period";
import {
  collectedCents,
  HANDLED_STRIPE_EVENTS,
  modeMatches,
  planForLookupKey,
  portalStatusFor,
  requireStripe,
  subscriptionIdFromInvoice,
} from "@/lib/payments/stripe";
import { unlockClientFeatures } from "./entitlements";
import { billingDayFromAnchor } from "@/lib/billing/billing-day";
import { retireHandBilledPlans } from "./hand-billed-plans";
import { settleOneOffCheckout } from "./stripe-one-off";
import { describeDiscounts, SUBSCRIPTION_EXPAND } from "@/lib/payments/promos";

/**
 * Turning Stripe events into portal state.
 *
 * ## The three rules this file exists to enforce
 *
 * **1. Allowances are never touched here.** A client's monthly change
 * allowance is created lazily on first use, keyed by `(client, calendar
 * month)`, and it is granted by the *plan*, not by a payment. That means a
 * duplicated `invoice.paid`, a replayed event, or ten retries of the same
 * delivery cannot double-grant anything, because no path in this file grants
 * an allowance at all. It is structural rather than defensive, which is why
 * there is no "have I already granted this month" check anywhere below —
 * there is nothing to check.
 *
 * The one exception is buying an extra change, which is a one-off checkout
 * rather than an invoice. That goes through `confirmPaymentReceived` like a
 * Venmo confirmation does, and is credited only by the call that moves the
 * payment request to `paid` — so it is credited once, however many events
 * describe it.
 *
 * **2. Subscription state is re-fetched, never trusted from the payload.**
 * Stripe does not guarantee delivery order, and a `customer.subscription.
 * updated` from 10:00 can arrive after the one from 10:05. Writing whatever
 * the payload says would let the older event overwrite newer state and, for
 * example, resurrect a cancelled subscription. Re-reading the subscription
 * from the API at processing time means the state written is current
 * regardless of arrival order.
 *
 * **3. Visiting the success URL proves nothing.** Nothing in the portal grants
 * paid access on a redirect. `checkout.session.completed` links the
 * subscription to the tenant; only a settled invoice records money.
 *
 * ## Settlement is not cash
 *
 * `invoice.paid` fires for invoices that collected nothing — a zero total, one
 * covered by credit, one an operator marked paid by hand. The ledger row
 * records `amount_paid`, which is what Stripe actually collected, so those
 * appear as the zero they are instead of inflating revenue.
 */

export type StripeOutcome =
  | { status: "processed"; note: string }
  | { status: "duplicate" }
  | { status: "ignored"; note: string }
  | { status: "unmatched"; note: string };

/**
 * Claim this event id, or discover somebody already has.
 *
 * The unique index on `(provider, delivery_id)` is the idempotency mechanism.
 * The row is inserted `status: "received"` and only moved to `processed` after
 * the work is durable — so a crash between the two leaves a claimed-but-
 * unprocessed row, and the retry below picks it up rather than skipping it.
 */
async function claimDelivery(
  db: Database,
  event: Stripe.Event,
): Promise<"claimed" | "retry" | "duplicate"> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      provider: "stripe",
      deliveryId: event.id,
      event: event.type,
      signatureValid: true,
      status: "received",
    })
    .onConflictDoNothing({
      target: [webhookDeliveries.provider, webhookDeliveries.deliveryId],
    })
    .returning({ id: webhookDeliveries.id });

  if (inserted.length > 0) return "claimed";

  // Already present. Whether this is a true duplicate or a retry of something
  // that died mid-flight is decided by whether it ever reached a terminal
  // state — treating an unfinished row as a duplicate is how a transient
  // failure becomes a permanently lost payment.
  const existing = await db
    .select({ status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.provider, "stripe"),
        eq(webhookDeliveries.deliveryId, event.id),
      ),
    )
    .limit(1);

  const status = existing[0]?.status ?? "received";
  return status === "received" || status === "failed" ? "retry" : "duplicate";
}

async function markDelivery(
  db: Database,
  eventId: string,
  status: string,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status, processedAt: new Date() })
    .where(
      and(
        eq(webhookDeliveries.provider, "stripe"),
        eq(webhookDeliveries.deliveryId, eventId),
      ),
    );
}

/**
 * Find the tenant an object belongs to.
 *
 * Three routes, most reliable first:
 *
 *  1. The `client_id` we wrote into the object's own metadata at creation.
 *  2. The stored `clients.stripe_customer_id`.
 *  3. The `client_id` on the *customer's* metadata, read from Stripe.
 *
 * Route 3 exists for a real race: Stripe can deliver an event before the
 * function that created the customer has written the id back, so route 2
 * misses. Without it, a client's very first payment can land as unmatched.
 *
 * Returns null rather than guessing. An unmatched event is recorded for an
 * operator to look at; attaching money to the wrong tenant would unlock an
 * account that did not pay and is far worse than a queue entry.
 *
 * That includes the two routes disagreeing: metadata naming one client while
 * the customer is stored against another. Either could be the stale one, and
 * picking is a guess about whose money this is.
 *
 * Exported for the reconciliation job, which repairs a missed event using the
 * same evidence the receiver would have used — no more, no less.
 */
export async function matchClient(
  db: Database,
  input: {
    metadata?: Stripe.Metadata | null;
    customerId?: string | null;
  },
): Promise<{ clientId: string; organizationId: string } | null> {
  const byCustomer = input.customerId
    ? (
        await db
          .select({ clientId: clients.id, organizationId: clients.organizationId })
          .from(clients)
          .where(eq(clients.stripeCustomerId, input.customerId))
          .limit(1)
      )[0]
    : undefined;

  const fromMetadata = input.metadata?.client_id;
  if (fromMetadata) {
    const rows = await db
      .select({ clientId: clients.id, organizationId: clients.organizationId })
      .from(clients)
      .where(eq(clients.id, fromMetadata))
      .limit(1);
    if (rows[0]) {
      if (byCustomer && byCustomer.clientId !== rows[0].clientId) return null;
      return rows[0];
    }
  }

  if (input.customerId) {
    if (byCustomer) return byCustomer;

    try {
      const customer = await requireStripe().customers.retrieve(
        input.customerId,
      );
      if (!customer.deleted) {
        const clientId = customer.metadata?.client_id;
        if (clientId) {
          const byMeta = await db
            .select({
              clientId: clients.id,
              organizationId: clients.organizationId,
            })
            .from(clients)
            .where(eq(clients.id, clientId))
            .limit(1);

          if (byMeta[0]) {
            // Heal the missing link so the next event takes route 2.
            await db
              .update(clients)
              .set({
                stripeCustomerId: input.customerId,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(clients.id, byMeta[0].clientId),
                  sql`${clients.stripeCustomerId} IS NULL`,
                ),
              );
            return byMeta[0];
          }
        }
      }
    } catch {
      // A customer we cannot read is a customer we cannot match. Fall through
      // to unmatched rather than failing the whole delivery.
    }
  }

  return null;
}

/**
 * The metadata that names the tenant on an invoice.
 *
 * A subscription's invoices carry no metadata of their own: the `client_id`
 * checkout wrote is copied to `parent.subscription_details.metadata`, not to
 * `invoice.metadata`. Reading only the latter made every subscription invoice
 * depend on the stored customer id, which is exactly the link that is missing
 * on a client's first payment.
 */
export function invoiceMetadata(invoice: Stripe.Invoice): Stripe.Metadata | null {
  if (invoice.metadata?.client_id) return invoice.metadata;
  const parent = (
    invoice as Stripe.Invoice & {
      parent?: { subscription_details?: { metadata?: Stripe.Metadata | null } | null } | null;
    }
  ).parent;
  return parent?.subscription_details?.metadata ?? invoice.metadata ?? null;
}

export function customerIdOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    return String((value as { id: unknown }).id);
  }
  return null;
}

/**
 * Mirror a Stripe subscription onto the local row.
 *
 * The subscription is re-fetched by the caller, so this always writes current
 * state and arrival order stops mattering.
 *
 * A complimentary client is never modified. `comp_plan_id` is an operator's
 * decision that this client does not pay; letting a payment event rewrite
 * their plan or status would undo it silently, and the person who set it would
 * have no way of knowing.
 *
 * Exported for the reconciliation job: one mirror, so a repaired subscription
 * is written exactly as a delivered event would have written it.
 */
export async function mirrorSubscription(
  db: Database,
  clientId: string,
  organizationId: string,
  subscription: Stripe.Subscription,
): Promise<"mirrored" | "skipped_comp"> {
  const compRows = await db
    .select({ compPlanId: clients.compPlanId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (compRows[0]?.compPlanId) return "skipped_comp";

  const item = subscription.items.data[0];
  const lookupKey = item?.price?.lookup_key ?? null;
  const planKey = lookupKey ? planForLookupKey(lookupKey) : null;

  let planId: string | null = null;
  if (planKey) {
    const planRows = await db
      .select({ id: servicePlans.id })
      .from(servicePlans)
      .where(eq(servicePlans.key, planKey))
      .limit(1);
    planId = planRows[0]?.id ?? null;
  }

  // `current_period_end` moved onto the subscription item in the 2025 API
  // versions. Read the item first and fall back, for the same reason the
  // invoice helper reads both shapes.
  const periodEndSeconds =
    (item as unknown as { current_period_end?: number })?.current_period_end ??
    (subscription as unknown as { current_period_end?: number })
      .current_period_end ??
    null;

  const status = portalStatusFor(subscription.status);
  const priceCents = item?.price?.unit_amount ?? 0;
  const now = new Date();
  // Undefined when the promo could not be read: the stored one is left alone
  // rather than wiped, because the client may well still have it.
  const discount = await describeDiscounts(subscription, priceCents);

  const values = {
    ...(discount ?? {}),
    provider: "stripe",
    providerSubscriptionId: subscription.id,
    providerStatus: subscription.status,
    status,
    planId,
    monthlyPriceCents: priceCents,
    currency: (subscription.items.data[0]?.price?.currency ?? "usd").toUpperCase(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null,
    recurringEnabledAt: now,
    // The day Stripe actually charges on: the anchor, which is the day the
    // operator chose when checkout set one, and the signup day otherwise.
    billingDay: billingDayFromAnchor(
      (subscription as unknown as { billing_cycle_anchor?: number }).billing_cycle_anchor ??
        subscription.start_date,
    ),
  };

  const updated = await db
    .update(subscriptions)
    .set(values)
    .where(
      and(
        eq(subscriptions.provider, "stripe"),
        eq(subscriptions.providerSubscriptionId, subscription.id),
      ),
    )
    .returning({ id: subscriptions.id });

  if (updated.length === 0) {
    await db
      .insert(subscriptions)
      .values({
        ...values,
        publicId: newPublicId(),
        clientId,
        startedOn: businessDate(new Date(subscription.start_date * 1000)),
      })
      .onConflictDoNothing({
        target: [subscriptions.provider, subscriptions.providerSubscriptionId],
      });
  }

  if (status === "active") {
    await retireHandBilledPlans(db, {
      clientId,
      organizationId,
      stripeSubscriptionId: subscription.id,
      stripeStartedAt: new Date(subscription.start_date * 1000),
      // What Stripe actually charges each month, promo included: that is the
      // figure a hand-raised invoice for the same month would have asked for.
      stripeMonthlyCents: discount?.discountedPriceCents ?? priceCents,
    });
  }

  await db.insert(auditLog).values({
    organizationId,
    action: "subscription.synced",
    entityType: "subscription",
    entityId: subscription.id,
    metadata: {
      source: "stripe_webhook",
      stripeStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      planKey,
      discount: discount?.discountLabel ?? null,
    },
  });

  return "mirrored";
}

/**
 * Record a settled invoice in the ledger.
 *
 * Idempotent on `payments.idempotency_key`, which is derived from the invoice
 * id — so a duplicated `invoice.paid` inserts nothing the second time. This is
 * the belt to the delivery table's braces: the delivery id protects against
 * the same *event* twice, this protects against two different events
 * describing the same invoice.
 *
 * `amount_paid` and not `total`. See the module comment: a zero invoice, one
 * settled from credit, and one marked paid by hand are all `paid`, and none of
 * them is money that arrived.
 */
async function recordInvoicePayment(
  db: Database,
  clientId: string,
  organizationId: string,
  invoice: Stripe.Invoice,
  source: "stripe_webhook" | "stripe_reconcile",
): Promise<"recorded" | "already" | "no_cash"> {
  const cents = collectedCents(invoice);
  const idempotencyKey = `stripe_invoice:${invoice.id}`;

  const existing = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing[0]) return "already";

  const subscriptionId = subscriptionIdFromInvoice(invoice);
  let localSubscriptionId: string | null = null;
  if (subscriptionId) {
    const rows = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, "stripe"),
          eq(subscriptions.providerSubscriptionId, subscriptionId),
        ),
      )
      .limit(1);
    localSubscriptionId = rows[0]?.id ?? null;
  }

  const line = invoice.lines?.data[0];
  const periodStart = line?.period?.start
    ? businessDate(new Date(line.period.start * 1000))
    : null;
  const periodEnd = line?.period?.end
    ? businessDate(new Date(line.period.end * 1000))
    : null;

  await db
    .insert(payments)
    .values({
      publicId: newPublicId(),
      clientId,
      subscriptionId: localSubscriptionId,
      amountCents: cents,
      currency: (invoice.currency ?? "usd").toUpperCase(),
      method: "stripe",
      provider: "stripe",
      providerReference: invoice.id,
      receiptUrl: invoice.hosted_invoice_url ?? null,
      idempotencyKey,
      coversPeriodStart: periodStart,
      coversPeriodEnd: periodEnd,
      receivedOn: businessDate(
        invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : new Date(),
      ),
      // No `recordedBy`: nobody confirmed this by hand. The audit row below
      // records that it was automatic, which is more honest than attributing
      // it to whichever admin happened to configure the webhook.
      recordedBy: null,
      status: "recorded",
      note:
        cents === 0
          ? "Stripe invoice settled without collecting cash (credit, zero total, or marked paid)."
          : null,
    })
    .onConflictDoNothing({ target: payments.idempotencyKey });

  await db.insert(auditLog).values({
    organizationId,
    action: "payment.recorded",
    entityType: "payment",
    entityId: invoice.id ?? "",
    metadata: {
      source,
      amountPaidCents: cents,
      invoiceTotalCents: invoice.total ?? 0,
      collectedCash: cents > 0,
    },
  });

  return cents > 0 ? "recorded" : "no_cash";
}

/**
 * Everything a settled invoice means, in one place.
 *
 * The receiver calls this for `invoice.paid`, and the reconciliation job calls
 * it for a settled invoice whose event never arrived. One function rather than
 * two copies, because the two drifting apart is how a missed webhook would get
 * repaired into a different state than a delivered one produces: money
 * recorded but features left locked, or the reverse.
 *
 * Every step is idempotent — the ledger row is keyed on the invoice, the
 * mirror writes current Stripe state, the unlock is first-write-wins — so the
 * receiver and the job both reaching the same invoice changes nothing twice.
 */
export async function applyPaidInvoice(
  db: Database,
  match: { clientId: string; organizationId: string },
  invoice: Stripe.Invoice,
  source: "stripe_webhook" | "stripe_reconcile",
): Promise<"recorded" | "already" | "no_cash"> {
  const compRows = await db
    .select({ compPlanId: clients.compPlanId })
    .from(clients)
    .where(eq(clients.id, match.clientId))
    .limit(1);
  const comped = Boolean(compRows[0]?.compPlanId);

  // The subscription first, so the ledger row below can point at it. On a
  // client's first payment the mirror may not exist yet — its own event can
  // arrive after this one, or never — and a payment recorded before it would
  // stay unlinked from its subscription for good.
  //
  // This also refreshes the paid-through date, so the billing page reflects a
  // renewal immediately rather than waiting for a separate subscription event.
  const subId = subscriptionIdFromInvoice(invoice);
  if (subId && !comped) {
    const fresh = await requireStripe().subscriptions.retrieve(subId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    await mirrorSubscription(db, match.clientId, match.organizationId, fresh);
  }

  const outcome = await recordInvoicePayment(
    db,
    match.clientId,
    match.organizationId,
    invoice,
    source,
  );

  // Money arriving lifts any dunning pause and turns the features on.
  // Idempotent and first-write-wins, so a renewal does not reset the original
  // unlock date. Skipped for a comp client, whose entitlements are the
  // operator's to decide.
  if (!comped && collectedCents(invoice) > 0) {
    await db
      .update(clients)
      .set({
        managementState: "managed",
        managementPausedAt: null,
        managementPausedReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(clients.id, match.clientId),
          sql`${clients.managementState} <> 'managed'`,
        ),
      );

    await unlockClientFeatures(db, match.clientId, {
      actorUserId: null,
      reason: "stripe_invoice_paid",
    });
  }

  return outcome;
}

/**
 * Process one verified event.
 *
 * Throws on a transient failure. The route turns that into a 500 and Stripe
 * retries; the delivery row stays un-processed so the retry does real work.
 */
export async function processStripeEvent(
  db: Database,
  event: Stripe.Event,
): Promise<StripeOutcome> {
  // A live event reaching a test-keyed deployment (or the reverse) must never
  // change state. It would unlock a client against money this environment
  // cannot see.
  if (!modeMatches(event.livemode)) {
    await claimDelivery(db, event);
    await markDelivery(db, event.id, "wrong_mode");
    return {
      status: "ignored",
      note: `Event livemode=${event.livemode} does not match configured key.`,
    };
  }

  if (!HANDLED_STRIPE_EVENTS.has(event.type)) {
    return { status: "ignored", note: `Unhandled type ${event.type}.` };
  }

  const claim = await claimDelivery(db, event);
  if (claim === "duplicate") return { status: "duplicate" };

  const stripe = requireStripe();

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const match = await matchClient(db, {
          metadata: session.metadata,
          customerId: customerIdOf(session.customer),
        });

        if (!match) {
          await markDelivery(db, event.id, "unmatched");
          return {
            status: "unmatched",
            note: `No client for checkout session ${session.id}.`,
          };
        }

        // A one-off payment against one of our invoices, not a subscription.
        if (session.mode === "payment") {
          const settled = await settleOneOffCheckout(db, {
            sessionId: session.id,
            eventType: event.type,
            match,
          });
          await markDelivery(db, event.id, settled.deliveryStatus);
          return settled.outcome;
        }

        // Linking only. A completed session is not proof of payment — with a
        // delayed payment method it is explicitly not payment yet — so this
        // records the relationship and waits for an invoice to settle.
        const subId = customerIdOf(session.subscription);
        if (subId) {
          const fresh = await stripe.subscriptions.retrieve(subId, { expand: SUBSCRIPTION_EXPAND });
          await mirrorSubscription(
            db,
            match.clientId,
            match.organizationId,
            fresh,
          );
        }

        await markDelivery(db, event.id, "processed");
        return {
          status: "processed",
          note: `Linked checkout session ${session.id}.`,
        };
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const payload = event.data.object as Stripe.Subscription;
        const match = await matchClient(db, {
          metadata: payload.metadata,
          customerId: customerIdOf(payload.customer),
        });

        if (!match) {
          await markDelivery(db, event.id, "unmatched");
          return {
            status: "unmatched",
            note: `No client for subscription ${payload.id}.`,
          };
        }

        // Re-fetch rather than trusting the payload — this is what makes
        // out-of-order delivery harmless. A deleted subscription still reads
        // back, carrying `status: "canceled"`.
        const fresh = await stripe.subscriptions.retrieve(payload.id, { expand: SUBSCRIPTION_EXPAND });
        const result = await mirrorSubscription(
          db,
          match.clientId,
          match.organizationId,
          fresh,
        );

        await markDelivery(db, event.id, "processed");
        return {
          status: "processed",
          note:
            result === "skipped_comp"
              ? `Client is complimentary; subscription ${payload.id} not mirrored.`
              : `Mirrored subscription ${payload.id} (${fresh.status}).`,
        };
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const match = await matchClient(db, {
          metadata: invoiceMetadata(invoice),
          customerId: customerIdOf(invoice.customer),
        });

        if (!match) {
          await markDelivery(db, event.id, "unmatched");
          return {
            status: "unmatched",
            note: `No client for invoice ${invoice.id}.`,
          };
        }

        const outcome = await applyPaidInvoice(db, match, invoice, "stripe_webhook");

        await markDelivery(db, event.id, "processed");
        return {
          status: "processed",
          note: `Invoice ${invoice.id}: ${outcome}.`,
        };
      }

      case "invoice.payment_failed":
      case "invoice.payment_action_required": {
        const invoice = event.data.object as Stripe.Invoice;
        const match = await matchClient(db, {
          metadata: invoiceMetadata(invoice),
          customerId: customerIdOf(invoice.customer),
        });

        if (!match) {
          await markDelivery(db, event.id, "unmatched");
          return {
            status: "unmatched",
            note: `No client for invoice ${invoice.id}.`,
          };
        }

        // Deliberately does NOT pause management, take the site down, or
        // revoke anything. One failed charge is usually an expired card.
        // Stripe retries on its own schedule and the existing dunning ladder
        // handles the human side; hosting is never withdrawn for non-payment.
        const subId = subscriptionIdFromInvoice(invoice);
        if (subId) {
          const fresh = await stripe.subscriptions.retrieve(subId, { expand: SUBSCRIPTION_EXPAND });
          await mirrorSubscription(
            db,
            match.clientId,
            match.organizationId,
            fresh,
          );
        }

        await db.insert(auditLog).values({
          organizationId: match.organizationId,
          action:
            event.type === "invoice.payment_failed"
              ? "payment.failed"
              : "payment.action_required",
          entityType: "invoice",
          entityId: invoice.id ?? "",
          metadata: {
            source: "stripe_webhook",
            amountDueCents: invoice.amount_due ?? 0,
            attemptCount: invoice.attempt_count ?? 0,
            hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          },
        });

        await markDelivery(db, event.id, "processed");
        return {
          status: "processed",
          note: `Recorded ${event.type} for invoice ${invoice.id}.`,
        };
      }

      case "charge.refunded":
      case "charge.dispute.created": {
        const object = event.data.object as
          | Stripe.Charge
          | Stripe.Dispute;
        const customerId =
          "customer" in object ? customerIdOf(object.customer) : null;

        const match = await matchClient(db, { customerId });
        if (!match) {
          await markDelivery(db, event.id, "unmatched");
          return {
            status: "unmatched",
            note: `No client for ${event.type} ${object.id}.`,
          };
        }

        // Recorded, never auto-reversed. The ledger forbids deleting payments
        // and a refund is an adjustment an operator makes deliberately —
        // silently clawing back entitlements on a partial refund or a disputed
        // charge that is later won would lock out a paying client.
        await db.insert(auditLog).values({
          organizationId: match.organizationId,
          action:
            event.type === "charge.refunded"
              ? "payment.refunded"
              : "payment.disputed",
          entityType: "charge",
          entityId: object.id,
          metadata: {
            source: "stripe_webhook",
            needsOperatorReview: true,
            amountCents:
              "amount_refunded" in object
                ? object.amount_refunded
                : object.amount,
          },
        });

        await markDelivery(db, event.id, "needs_review");
        return {
          status: "processed",
          note: `${event.type} recorded for operator review.`,
        };
      }

      default:
        await markDelivery(db, event.id, "ignored");
        return { status: "ignored", note: `Unhandled type ${event.type}.` };
    }
  } catch (error) {
    // Leave the row un-processed so the retry re-runs it, and re-throw so the
    // route answers 500. Marking it failed-and-done here is what would turn a
    // blip into a permanently missed payment.
    await db
      .update(webhookDeliveries)
      .set({ status: "failed" })
      .where(
        and(
          eq(webhookDeliveries.provider, "stripe"),
          eq(webhookDeliveries.deliveryId, event.id),
        ),
      );
    throw error;
  }
}
