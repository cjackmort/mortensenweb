import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, paymentRequests } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { requireStripe } from "@/lib/payments/stripe";
import { confirmPaymentReceived } from "./billing";
import { systemActor } from "./system-actor";
import type { StripeOutcome } from "./stripe-webhooks";

/**
 * Settling an invoice paid through a one-off Stripe Checkout.
 *
 * The subscription half of the receiver records money from settled Stripe
 * *invoices*. A one-off payment has no Stripe invoice: it is a Checkout
 * Session in `payment` mode, created by `client/stripe-payment.ts` against one
 * of our payment requests. This turns that session into the same thing a Venmo
 * confirmation or a Square payment becomes — `confirmPaymentReceived`, the one
 * place a payment request is ever marked paid, which is also where an extra
 * change is credited.
 *
 * ## What has to be true before anything is recorded
 *
 * - **Stripe says the session is paid**, re-read from the API rather than taken
 *   from the event. A completed session can still be waiting on a bank
 *   transfer; that arrives later as `async_payment_succeeded`, and either
 *   event settling first leaves the other with nothing to do.
 * - **The invoice belongs to the client the checkout was for.** The session's
 *   metadata names both, and they are checked against each other. A mismatch
 *   goes to an operator; settling it would mark one client paid with another
 *   client's money.
 */

export interface OneOffSettlement {
  /** What to record on the delivery row. */
  deliveryStatus: string;
  outcome: StripeOutcome;
}

interface Match {
  clientId: string;
  organizationId: string;
}

/** The payment intent and the hosted receipt, from an expanded session. */
function chargeDetails(session: Stripe.Checkout.Session): {
  paymentIntentId: string | null;
  receiptUrl: string | null;
} {
  const intent = session.payment_intent;
  if (!intent || typeof intent === "string") {
    return { paymentIntentId: intent ?? null, receiptUrl: null };
  }
  const charge = intent.latest_charge;
  return {
    paymentIntentId: intent.id,
    receiptUrl:
      charge && typeof charge !== "string" ? (charge.receipt_url ?? null) : null,
  };
}

async function findRequest(db: Database, session: Stripe.Checkout.Session) {
  const columns = {
    publicId: paymentRequests.publicId,
    clientId: paymentRequests.clientId,
    amountCents: paymentRequests.amountCents,
  };

  const byMetadata = session.metadata?.payment_request_id;
  if (byMetadata) {
    const rows = await db
      .select(columns)
      .from(paymentRequests)
      .where(eq(paymentRequests.publicId, byMetadata))
      .limit(1);
    return rows[0] ?? null;
  }

  // A session without our metadata was not made by this portal's code, but
  // the id is stored on the invoice when it is — so it is still matchable.
  const rows = await db
    .select(columns)
    .from(paymentRequests)
    .where(eq(paymentRequests.providerReference, session.id))
    .limit(1);
  return rows[0] ?? null;
}

function review(note: string): OneOffSettlement {
  return { deliveryStatus: "needs_review", outcome: { status: "unmatched", note } };
}

export async function settleOneOffCheckout(
  db: Database,
  input: { sessionId: string; eventType: string; match: Match },
): Promise<OneOffSettlement> {
  const session = await requireStripe().checkout.sessions.retrieve(
    input.sessionId,
    { expand: ["payment_intent.latest_charge"] },
  );

  const request = await findRequest(db, session);
  if (!request) {
    return {
      deliveryStatus: "unmatched",
      outcome: {
        status: "unmatched",
        note: `No invoice for checkout session ${session.id}.`,
      },
    };
  }

  if (request.clientId !== input.match.clientId) {
    await db.insert(auditLog).values({
      organizationId: input.match.organizationId,
      action: "payment.client_mismatch",
      entityType: "payment_request",
      entityId: request.publicId,
      metadata: { source: "stripe_webhook", sessionId: session.id },
    });
    return review(
      `Checkout ${session.id} is for a different client than invoice ${request.publicId}.`,
    );
  }

  if (session.payment_status !== "paid") {
    if (input.eventType === "checkout.session.async_payment_failed") {
      await db.insert(auditLog).values({
        organizationId: input.match.organizationId,
        action: "payment.failed",
        entityType: "payment_request",
        entityId: request.publicId,
        metadata: { source: "stripe_webhook", sessionId: session.id },
      });
    }
    return {
      deliveryStatus: "processed",
      outcome: {
        status: "processed",
        note: `Checkout ${session.id} is ${session.payment_status}; nothing recorded yet.`,
      },
    };
  }

  const actor = await systemActor(db);
  if (!actor) {
    return review(`Checkout ${session.id} paid, but there is no admin to record it as.`);
  }

  const { paymentIntentId, receiptUrl } = chargeDetails(session);
  const confirmed = await confirmPaymentReceived(actor, db, request.publicId, {
    method: "stripe",
    provider: "stripe",
    providerReference: paymentIntentId ?? session.id,
    receiptUrl,
    receivedOn: businessDate(new Date()),
    note: `Stripe checkout ${session.id}`,
  });

  if (!confirmed.ok) {
    // Money arrived for an invoice that was cancelled or written off in the
    // meantime. It is still the client's money, so a person decides.
    return review(
      `Checkout ${session.id} paid invoice ${request.publicId}, which could not be confirmed (${confirmed.reason}).`,
    );
  }

  await db.insert(auditLog).values({
    actorUserId: actor.userId,
    organizationId: input.match.organizationId,
    action: "payment.confirmed_by_webhook",
    entityType: "payment_request",
    entityId: request.publicId,
    metadata: {
      source: "stripe_webhook",
      sessionId: session.id,
      paymentIntentId,
      amountCents: session.amount_total,
      alreadyConfirmed: confirmed.alreadyConfirmed,
    },
  });

  // Recorded, not rejected — the same stance as the Square receiver. A client
  // who paid has paid, whatever the figure.
  if (session.amount_total !== null && session.amount_total !== request.amountCents) {
    await db.insert(auditLog).values({
      actorUserId: actor.userId,
      organizationId: input.match.organizationId,
      action: "payment.amount_mismatch",
      entityType: "payment_request",
      entityId: request.publicId,
      metadata: { expected: request.amountCents, received: session.amount_total },
    });
  }

  return {
    deliveryStatus: "processed",
    outcome: {
      status: "processed",
      note: confirmed.alreadyConfirmed
        ? `Invoice ${request.publicId} was already settled.`
        : `Settled invoice ${request.publicId} from checkout ${session.id}.`,
    },
  };
}
