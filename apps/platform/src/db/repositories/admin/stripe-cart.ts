import { and, eq, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, clients, payments } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { newPublicId } from "@/lib/ids";
import { requireStripe } from "@/lib/payments/stripe";
import { unlockClientFeatures } from "./entitlements";
import type { StripeOutcome } from "./stripe-webhooks";

/**
 * Recording a cart checkout: the website build and, with a plan, a new
 * subscription, from one payment.
 *
 * Two shapes, decided by the checkout's mode (see `client/cart.ts`):
 *
 * - **With a plan** the build is a one-off line on the subscription's first
 *   invoice. `invoice.paid` records that invoice as two ledger rows keyed on
 *   it — `stripe_invoice:<id>:build` for the build after its promo, and
 *   `stripe_invoice:<id>` for the first month — so the build is never booked
 *   as subscription revenue, and a redelivery or the reconciliation job
 *   reaching the same invoice adds nothing. The completed checkout only links
 *   the subscription, as for any other.
 * - **The build alone** is a `payment` checkout with no Stripe invoice. The
 *   completed (or bank-transfer-settled) session is re-read and recorded as
 *   `stripe_checkout:<id>:build`.
 *
 * Either way `clients.build_paid_at` is stamped, first write wins, and the
 * client is not asked to pay for their website again.
 */

export const BUILD_NOTE = "Website build";

/** Whether a checkout, subscription or invoice came from the cart. */
export function fromCart(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.checkout === "cart";
}

function netOf(line: Stripe.InvoiceLineItem): number {
  const discounts = (line.discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
  return Math.max(0, line.amount - discounts);
}

function productOf(line: Stripe.InvoiceLineItem): string | null {
  return line.pricing?.price_details?.product ?? null;
}

/**
 * The build's share of a cart's first invoice, in cents; null for every other
 * invoice. Found by the build product the checkout wrote into the
 * subscription's metadata, falling back to the one-off lines, which on a
 * cart's first invoice are only ever the build. Never more than was collected.
 */
export function cartBuildCents(invoice: Stripe.Invoice, metadata: Stripe.Metadata | null): number | null {
  if (!fromCart(metadata) || invoice.billing_reason !== "subscription_create") return null;
  const product = metadata?.build_product || null;
  const lines = invoice.lines?.data ?? [];
  const build = lines.filter((line) =>
    product ? productOf(line) === product : line.parent?.type === "invoice_item_details",
  );
  const cents = build.reduce((sum, line) => sum + netOf(line), 0);
  return Math.min(cents, invoice.amount_paid ?? 0);
}

/** Stamp the website as paid. First write wins, so a replay keeps the original date. */
export async function markBuildPaid(db: Database, clientId: string): Promise<void> {
  const now = new Date();
  await db
    .update(clients)
    .set({ buildPaidAt: now, updatedAt: now })
    .where(and(eq(clients.id, clientId), isNull(clients.buildPaidAt)));
}

/**
 * What money arriving means for access: a dunning pause lifts and the paid
 * features turn on. Idempotent and first-write-wins, shared with the invoice
 * path in `applyPaidInvoice`.
 */
export async function resumeAndUnlock(db: Database, clientId: string, reason: string): Promise<void> {
  await db
    .update(clients)
    .set({ managementState: "managed", managementPausedAt: null, managementPausedReason: null, updatedAt: new Date() })
    .where(and(eq(clients.id, clientId), sql`${clients.managementState} <> 'managed'`));
  await unlockClientFeatures(db, clientId, { actorUserId: null, reason });
}

interface Match {
  clientId: string;
  organizationId: string;
}

export interface CartSettlement {
  deliveryStatus: string;
  outcome: StripeOutcome;
}

function chargeOf(session: Stripe.Checkout.Session): { reference: string; receiptUrl: string | null } {
  const intent = session.payment_intent;
  if (!intent || typeof intent === "string") return { reference: intent ?? session.id, receiptUrl: null };
  const charge = intent.latest_charge;
  return { reference: intent.id, receiptUrl: charge && typeof charge !== "string" ? (charge.receipt_url ?? null) : null };
}

/**
 * A cart paid for the build alone. Re-read from Stripe rather than taken from
 * the event: a completed session can still be waiting on a bank transfer, and
 * either of the two events that describe it may arrive first.
 */
export async function settleCartPayment(
  db: Database,
  input: { sessionId: string; eventType: string; match: Match },
): Promise<CartSettlement> {
  const session = await requireStripe().checkout.sessions.retrieve(input.sessionId, {
    expand: ["payment_intent.latest_charge"],
  });

  const settled = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!settled) {
    if (input.eventType === "checkout.session.async_payment_failed") {
      await db.insert(auditLog).values({
        organizationId: input.match.organizationId,
        action: "payment.failed",
        entityType: "checkout_session",
        entityId: session.id,
        metadata: { source: "stripe_webhook", kind: "build" },
      });
    }
    return {
      deliveryStatus: "processed",
      outcome: { status: "processed", note: `Cart checkout ${session.id} is ${session.payment_status}; nothing recorded yet.` },
    };
  }

  const cents = session.amount_total ?? 0;
  const { reference, receiptUrl } = chargeOf(session);
  const inserted = await db
    .insert(payments)
    .values({
      publicId: newPublicId(),
      clientId: input.match.clientId,
      amountCents: cents,
      currency: (session.currency ?? "usd").toUpperCase(),
      method: "stripe",
      provider: "stripe",
      providerReference: reference,
      receiptUrl,
      idempotencyKey: `stripe_checkout:${session.id}:build`,
      receivedOn: businessDate(new Date()),
      recordedBy: null,
      status: "recorded",
      note: BUILD_NOTE,
    })
    .onConflictDoNothing({ target: payments.idempotencyKey })
    .returning({ id: payments.id });

  if (inserted.length > 0) {
    await db.insert(auditLog).values({
      organizationId: input.match.organizationId,
      action: "payment.recorded",
      entityType: "checkout_session",
      entityId: session.id,
      metadata: { source: "stripe_webhook", kind: "build", amountPaidCents: cents, collectedCash: cents > 0 },
    });
  }

  await markBuildPaid(db, input.match.clientId);
  const [client] = await db
    .select({ compPlanId: clients.compPlanId })
    .from(clients)
    .where(eq(clients.id, input.match.clientId))
    .limit(1);
  if (!client?.compPlanId && cents > 0) await resumeAndUnlock(db, input.match.clientId, "stripe_build_paid");

  return {
    deliveryStatus: "processed",
    outcome: {
      status: "processed",
      note: inserted.length > 0 ? `Recorded the build from checkout ${session.id}.` : `Build from ${session.id} was already recorded.`,
    },
  };
}
