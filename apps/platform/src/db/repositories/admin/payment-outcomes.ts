import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, paymentRequests, payments } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { markBuildPaid } from "../build-standing";
import { expireOpenCheckouts } from "./checkout-expiry";
import { unlockClientFeatures } from "./entitlements";
import type { PaymentMethod } from "./billing";
import type { AdminContext } from "../context";

/**
 * The two answers the operator gives about money that is not on a processor:
 * "they paid" and "they did not".
 *
 * "They paid" against an invoice is `confirmPaymentReceived` (billing.ts), the
 * one path that ever marks an invoice paid. What lives here is the rest:
 * money that arrived with no invoice behind it, and every way of saying an
 * invoice was not paid.
 */

/** How money reaches the operator outside a processor. */
export const MANUAL_METHODS = [
  "venmo",
  "cash",
  "check",
  "card",
  "bank_transfer",
  "other",
] as const satisfies readonly PaymentMethod[];

export type ManualMethod = (typeof MANUAL_METHODS)[number];

export interface ManualPaymentInput {
  clientPublicId: string;
  amountCents: number;
  method: ManualMethod;
  /** `YYYY-MM-DD`. */
  receivedOn: string;
  note: string;
  /**
   * One per form render, so a double-submitted form records once. The same
   * job the invoice's reference does for `confirmPaymentReceived`.
   */
  idempotencyKey: string;
  /** The operator says this is the website build fee: it marks the build paid. */
  coversBuild?: boolean;
}

export type ManualPaymentResult =
  | { ok: true; duplicate: boolean; paymentPublicId: string }
  | { ok: false; reason: "not_found" };

/**
 * Record money that came in with no invoice: a build fee by check, a Venmo
 * for something agreed on the phone.
 *
 * It is income like any other, so it is in the ledger at once. It is the
 * build only when the operator says so (`coversBuild`) — never by being
 * money — and then the build is marked paid and any open checkout that would
 * charge for it again is closed. It unlocks the client's features as every
 * confirmed payment does, which `unlockClientFeatures` refuses while the build
 * is owed. It does not lift a dunning pause: that belongs to an overdue
 * invoice, and money not marked against it has not settled it.
 */
export async function recordManualPayment(
  ctx: AdminContext,
  db: Database,
  input: ManualPaymentInput,
): Promise<ManualPaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Amount must be a positive whole number of cents.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) {
    throw new Error("Received date must be YYYY-MM-DD.");
  }
  if (!MANUAL_METHODS.includes(input.method)) {
    throw new Error(`Unknown payment method: ${input.method}`);
  }

  const [client] = await db
    .select({ id: clients.id, organizationId: clients.organizationId })
    .from(clients)
    .where(
      and(
        eq(clients.publicId, input.clientPublicId),
        eq(clients.isInternal, false),
        isNull(clients.archivedAt),
      ),
    )
    .limit(1);
  if (!client) return { ok: false, reason: "not_found" };

  const inserted = await db
    .insert(payments)
    .values({
      publicId: newPublicId(),
      clientId: client.id,
      amountCents: input.amountCents,
      method: input.method,
      idempotencyKey: input.idempotencyKey,
      receivedOn: input.receivedOn,
      recordedBy: ctx.userId,
      status: "recorded",
      note: input.note.trim() || (input.coversBuild ? "Website build" : null),
    })
    .onConflictDoNothing({ target: payments.idempotencyKey })
    .returning({ publicId: payments.publicId });

  if (inserted.length === 0) {
    const [existing] = await db
      .select({ publicId: payments.publicId })
      .from(payments)
      .where(eq(payments.idempotencyKey, input.idempotencyKey))
      .limit(1);
    return { ok: true, duplicate: true, paymentPublicId: existing?.publicId ?? "" };
  }

  const paymentPublicId = inserted[0]!.publicId;

  if (input.coversBuild) {
    await markBuildPaid(db, client.id, {
      source: "manual_payment",
      actorUserId: ctx.userId,
      reference: paymentPublicId,
      amountCents: input.amountCents,
    });
    await expireOpenCheckouts(db, {
      clientId: client.id,
      organizationId: client.organizationId,
      includeBuild: true,
      reason: "build_paid_manually",
      actorUserId: ctx.userId,
    });
  }

  await unlockClientFeatures(db, client.id, {
    actorUserId: ctx.userId,
    reason: "payment_recorded",
  });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: "payment.recorded",
    entityType: "payment",
    entityId: paymentPublicId,
    metadata: {
      source: "manual",
      amountCents: input.amountCents,
      method: input.method,
      receivedOn: input.receivedOn,
      coversBuild: Boolean(input.coversBuild),
    },
  });

  return { ok: true, duplicate: false, paymentPublicId };
}

/**
 * "Not paid", three ways, because it means three different things:
 *
 * - `still_owed` — I checked and the money is not there. On an invoice the
 *   client said they paid, it goes back to `open` and onto the chase list
 *   (and their "I've paid" is cleared, so they can say it again when they
 *   do). On one already overdue nothing changes except a note that it was
 *   checked, shown on the row so the next look does not repeat the work.
 * - `cancel` — the charge was a mistake. Nobody owes it; `cancelled`.
 * - `write_off` — it was owed and is not going to be paid. Kept apart from a
 *   mistake (`written_off`) because a bad debt is a fact an accountant asks
 *   about and a typo is not.
 *
 * None of these sends anything to the client or changes their features. The
 * last two close the invoice's Stripe checkout if it is still open: nobody
 * owes it any more, so nobody can pay it.
 */
export type NotPaidOutcome = "still_owed" | "cancel" | "write_off";

export type NotPaidResult =
  | { ok: true; status: "open" | "overdue" | "cancelled" | "written_off" }
  | { ok: false; reason: "not_found" | "not_unpaid" };

const UNPAID = ["open", "overdue", "awaiting_confirmation"] as const;

export async function markInvoiceNotPaid(
  ctx: AdminContext,
  db: Database,
  requestPublicId: string,
  { outcome, note }: { outcome: NotPaidOutcome; note: string },
): Promise<NotPaidResult> {
  const [request] = await db
    .select({
      id: paymentRequests.id,
      status: paymentRequests.status,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      clientId: paymentRequests.clientId,
      providerReference: paymentRequests.providerReference,
      organizationId: clients.organizationId,
    })
    .from(paymentRequests)
    .innerJoin(clients, eq(clients.id, paymentRequests.clientId))
    .where(eq(paymentRequests.publicId, requestPublicId))
    .limit(1);

  if (!request) return { ok: false, reason: "not_found" };
  if (!(UNPAID as readonly string[]).includes(request.status)) {
    return { ok: false, reason: "not_unpaid" };
  }

  const now = new Date();
  const why = note.trim() || null;
  let status: "open" | "overdue" | "cancelled" | "written_off";

  if (outcome === "still_owed") {
    if (request.status === "awaiting_confirmation") {
      await db
        .update(paymentRequests)
        .set({ status: "open", initiatedAt: null, updatedAt: now })
        .where(
          and(
            eq(paymentRequests.id, request.id),
            eq(paymentRequests.status, "awaiting_confirmation"),
          ),
        );
      status = "open";
    } else {
      status = request.status as "open" | "overdue";
    }
  } else {
    status = outcome === "cancel" ? "cancelled" : "written_off";
    const changed = await db
      .update(paymentRequests)
      .set({ status, updatedAt: now })
      .where(and(eq(paymentRequests.id, request.id), inArray(paymentRequests.status, [...UNPAID])))
      .returning({ id: paymentRequests.id });
    if (changed.length === 0) return { ok: false, reason: "not_unpaid" };

    await expireOpenCheckouts(db, {
      clientId: request.clientId,
      organizationId: request.organizationId,
      sessionIds: [request.providerReference],
      reason: outcome === "cancel" ? "invoice_cancelled" : "invoice_written_off",
      actorUserId: ctx.userId,
    });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: request.organizationId,
    action:
      outcome === "still_owed"
        ? "payment_request.checked"
        : outcome === "cancel"
          ? "payment_request.cancelled"
          : "payment_request.written_off",
    entityType: "payment_request",
    entityId: requestPublicId,
    metadata: {
      reference: request.reference,
      amountCents: request.amountCents,
      previousStatus: request.status,
      note: why,
    },
  });

  return { ok: true, status };
}
