import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  paymentRequests,
  subscriptions,
  webhookDeliveries,
} from "@/db/schema";
import {
  HANDLED_SQUARE_EVENTS,
  parseSquareEvent,
  referenceFromNote,
} from "@/lib/payments/square";
import { confirmPaymentReceived } from "./billing";
import type { AdminContext } from "../context";

/**
 * Processing a Square notification.
 *
 * This is what turns "the client pressed pay" into "the money arrived" without
 * anybody watching. It shares its shape with the GitHub receiver deliberately —
 * same idempotency mechanism, same allowlist-not-denylist stance, same rule
 * that an unrecognised event is acknowledged and dropped rather than treated as
 * an error.
 *
 * ## What it does not do
 *
 * It does not remove `awaiting_confirmation`. A webhook can arrive late, twice,
 * or never; Square narrows the window between paying and being confirmed, and
 * an operator can still confirm by hand when a notification is lost. The state
 * exists because off-platform rails need it, and Square being better does not
 * make it unnecessary.
 *
 * It also refuses to act on anything other than `COMPLETED`. Square emits
 * events for authorisations, failures, and pending states, and a payment that
 * is merely *approved* is not money — treating it as such would unlock a client
 * whose card is later declined.
 */

/**
 * Square has no equivalent of GitHub's delivery id header; the body's
 * `event_id` is the idempotency key. It is stored in the same
 * `webhook_deliveries` table under a different provider, so one query answers
 * "what has this platform received" across both integrations.
 */
async function claimDelivery(
  db: Database,
  input: {
    eventId: string;
    type: string | null;
    signatureValid: boolean;
  },
): Promise<boolean> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      provider: "square",
      deliveryId: input.eventId,
      event: input.type,
      signatureValid: input.signatureValid,
      status: "received",
    })
    .onConflictDoNothing({
      target: [webhookDeliveries.provider, webhookDeliveries.deliveryId],
    })
    .returning({ id: webhookDeliveries.id });

  return inserted.length > 0;
}

async function markProcessed(
  db: Database,
  eventId: string,
  status: string,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status, processedAt: new Date() })
    .where(
      and(
        eq(webhookDeliveries.provider, "square"),
        eq(webhookDeliveries.deliveryId, eventId),
      ),
    );
}

export type SquareOutcome =
  | { status: "processed"; note: string }
  | { status: "duplicate" }
  | { status: "ignored"; note: string }
  | { status: "rejected"; note: string };

export interface SquareDeliveryInput {
  /** Already parsed by the route, which verified the signature over raw bytes. */
  payload: unknown;
  signatureValid: boolean;
  /** Falls back to a body-derived id when the payload could not be parsed. */
  fallbackId: string;
}

/**
 * A system actor for payments nobody confirmed by hand.
 *
 * `confirmPaymentReceived` records who confirmed, and the schema requires a
 * named user for `paid`. A webhook has no user, so the operator account stands
 * in — with `metadata.source` on the audit row recording that it was automatic.
 * Attributing it to the person who happened to configure Square would be worse:
 * the ledger would claim they checked something they never saw.
 */
async function systemActor(db: Database): Promise<AdminContext | null> {
  const rows = await db.execute(
    sql`select id from users where role = 'admin' and status = 'active' order by created_at limit 1`,
  );
  const id = (rows.rows[0] as { id?: string } | undefined)?.id;
  return id ? ({ userId: id } as AdminContext) : null;
}

/**
 * Match a Square payment to the invoice it settles.
 *
 * By our reference code first — it rides along in the payment note and is the
 * same key Venmo reconciliation uses. Failing that, the payment link id, which
 * is recorded on the request when the checkout is created.
 *
 * Returning null puts the payment in front of a human. Guessing which invoice
 * an unlabelled payment settles is how one client gets credited for another's
 * money, and that error is close to undetectable once made.
 */
interface MatchedRequest {
  publicId: string;
  clientId: string;
  amountCents: number;
  purpose: "subscription" | "extra_change" | "other";
  coversPeriodStart: string | null;
}

async function findRequest(
  db: Database,
  event: { note?: string; orderId?: string },
): Promise<MatchedRequest | null> {
  const reference = referenceFromNote(event.note);

  if (reference) {
    const rows = await db
      .select({
        publicId: paymentRequests.publicId,
        clientId: paymentRequests.clientId,
        amountCents: paymentRequests.amountCents,
        purpose: paymentRequests.purpose,
        coversPeriodStart: paymentRequests.coversPeriodStart,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.reference, reference))
      .limit(1);
    if (rows[0]) return rows[0];
  }

  if (event.orderId) {
    const rows = await db
      .select({
        publicId: paymentRequests.publicId,
        clientId: paymentRequests.clientId,
        amountCents: paymentRequests.amountCents,
        purpose: paymentRequests.purpose,
        coversPeriodStart: paymentRequests.coversPeriodStart,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.providerReference, event.orderId))
      .limit(1);
    if (rows[0]) return rows[0];
  }

  return null;
}

export async function processSquareDelivery(
  db: Database,
  input: SquareDeliveryInput,
): Promise<SquareOutcome> {
  const event = parseSquareEvent(input.payload);
  const eventId = event?.eventId ?? input.fallbackId;

  const claimed = await claimDelivery(db, {
    eventId,
    type: event?.type ?? null,
    signatureValid: input.signatureValid,
  });

  if (!claimed) return { status: "duplicate" };

  if (!input.signatureValid) {
    await markProcessed(db, eventId, "rejected_signature");
    return { status: "rejected", note: "Signature did not verify." };
  }

  if (!event) {
    await markProcessed(db, eventId, "ignored");
    return { status: "ignored", note: "Payload was not a recognisable event." };
  }

  if (!HANDLED_SQUARE_EVENTS.has(event.type)) {
    await markProcessed(db, eventId, "ignored");
    return { status: "ignored", note: `Unhandled event: ${event.type}.` };
  }

  let outcome: SquareOutcome;
  try {
    outcome = await handleEvent(db, event);
  } catch (error) {
    await markProcessed(db, eventId, "failed");
    throw error;
  }

  await markProcessed(db, eventId, outcome.status);
  return outcome;
}

async function handleEvent(
  db: Database,
  event: NonNullable<ReturnType<typeof parseSquareEvent>>,
): Promise<SquareOutcome> {
  // Subscription lifecycle: records that recurring billing is genuinely on.
  // Kept separate from payment handling because a subscription being created
  // is not money arriving — the first charge comes as its own event.
  if (event.type.startsWith("subscription.")) {
    if (!event.subscriptionId) {
      return { status: "ignored", note: "Subscription event with no id." };
    }

    const updated = await db
      .update(subscriptions)
      .set({
        provider: "square",
        providerSubscriptionId: event.subscriptionId,
        recurringEnabledAt: sql`COALESCE(${subscriptions.recurringEnabledAt}, now())`,
      })
      .where(
        and(
          eq(subscriptions.providerSubscriptionId, event.subscriptionId),
          eq(subscriptions.status, "active"),
        ),
      )
      .returning({ id: subscriptions.id });

    return updated.length > 0
      ? { status: "processed", note: "Recurring billing recorded." }
      : { status: "ignored", note: "No subscription matched." };
  }

  // Only COMPLETED means the money is ours. An authorisation is a promise.
  if (event.status && event.status !== "COMPLETED") {
    return { status: "ignored", note: `Payment status ${event.status}.` };
  }

  const request = await findRequest(db, event);
  if (!request) {
    // Deliberately "processed": we received it, understood it, and decided it
    // needs a human. Recording it as failed would imply a bug to fix.
    return {
      status: "processed",
      note: "Payment did not match any invoice; left for manual reconciliation.",
    };
  }

  const actor = await systemActor(db);
  if (!actor) {
    return { status: "processed", note: "No admin account to attribute the confirmation to." };
  }

  const confirmed = await confirmPaymentReceived(actor, db, request.publicId, {
    method: "square",
    // Square's own timestamp is on the event; the ledger records the date the
    // money arrived, and using our clock is close enough at day granularity.
    receivedOn: new Date().toISOString().slice(0, 10),
    note: `Square payment ${event.paymentId ?? "(no id)"}`,
  });

  if (!confirmed.ok) {
    return { status: "processed", note: `Could not confirm: ${confirmed.reason}.` };
  }

  await db.insert(auditLog).values({
    actorUserId: actor.userId,
    action: "payment.confirmed_by_webhook",
    entityType: "payment_request",
    entityId: request.publicId,
    metadata: {
      source: "square_webhook",
      squarePaymentId: event.paymentId ?? null,
      amountCents: event.amountCents ?? null,
      alreadyConfirmed: confirmed.alreadyConfirmed,
    },
  });

  // Amount mismatches are recorded, not rejected. A client who paid the wrong
  // amount has still paid, and refusing the whole event would leave them
  // looking unpaid while their money sits in the account.
  if (event.amountCents && event.amountCents !== request.amountCents) {
    await db.insert(auditLog).values({
      actorUserId: actor.userId,
      action: "payment.amount_mismatch",
      entityType: "payment_request",
      entityId: request.publicId,
      metadata: { expected: request.amountCents, received: event.amountCents },
    });
  }

  // Extra-change allowance top-up, dunning-pause release, and the audit trail
  // for both all now live inside `confirmPaymentReceived` itself — it's the
  // single choke point every payment confirmation passes through (this
  // webhook included), so duplicating that logic here risked it drifting
  // out of sync with the manual-confirm path. See billing.ts.

  // Payment settles the account, so any dunning pause lifts. `confirmPaymentReceived`
  // already does this; repeated here only for clients whose row predates it.
  await db
    .update(clients)
    .set({ managementState: "managed", updatedAt: new Date() })
    .where(
      and(
        eq(clients.id, request.clientId),
        sql`${clients.managementState} <> 'managed'`,
      ),
    );

  return {
    status: "processed",
    note: confirmed.alreadyConfirmed
      ? "Already confirmed; nothing further recorded."
      : "Payment confirmed and entitlements unlocked.",
  };
}
