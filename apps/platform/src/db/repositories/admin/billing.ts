import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  paymentRequests,
  payments,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { generatePaymentReference } from "@/lib/payments/venmo";
import { daysOverdue } from "@/lib/billing/dunning";
import { unlockClientFeatures } from "./entitlements";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Money, from the operator's side.
 *
 * Three rules shape everything here, and all three come from the fact that
 * Venmo gives us no callback:
 *
 * 1. **`payments` is append-only.** Nothing in this module deletes or edits a
 *    ledger row. A mistake is corrected by recording another row, never by
 *    rewriting history, because the ledger is what you would hand an
 *    accountant.
 *
 * 2. **Only a human marks money as received.** The platform cannot observe a
 *    Venmo transfer. `status = 'paid'` therefore requires both a timestamp and
 *    a named user, and the schema enforces that with a check constraint rather
 *    than trusting this code.
 *
 * 3. **Confirming twice must not bill twice.** Operators double-click, and
 *    retries happen. Confirmation is idempotent: it claims the request with a
 *    conditional update and keys the ledger row so a second attempt cannot
 *    insert a duplicate.
 */

export type PaymentMethod =
  | "cash"
  | "venmo"
  | "check"
  | "card"
  | "bank_transfer"
  | "stripe"
  | "square"
  | "other";

export interface NewPaymentRequestInput {
  organizationId: string;
  amountCents: number;
  /** ISO date (YYYY-MM-DD). */
  dueOn: string;
  coversPeriodStart?: string;
  coversPeriodEnd?: string;
  note?: string;
}

/** Resolve the client row for an organization, or throw. */
async function requireClient(db: Database, organizationId: string) {
  const rows = await db
    .select({ id: clients.id, publicId: clients.publicId })
    .from(clients)
    .where(eq(clients.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Raise a payment request — an invoice.
 *
 * The reference is the reconciliation key: it goes in the Venmo note and is how
 * an arriving payment is matched back to what was asked for. It must be unique,
 * so a collision retries rather than failing the operation.
 */
export async function raisePaymentRequest(
  ctx: AdminContext,
  db: Database,
  input: NewPaymentRequestInput,
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Amount must be a positive whole number of cents.");
  }

  const client = await requireClient(db, input.organizationId);

  let reference = generatePaymentReference();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await db
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.reference, reference))
      .limit(1);
    if (taken.length === 0) break;
    reference = generatePaymentReference();
  }

  const inserted = await db
    .insert(paymentRequests)
    .values({
      publicId: newPublicId(),
      clientId: client.id,
      reference,
      amountCents: input.amountCents,
      dueOn: input.dueOn,
      coversPeriodStart: input.coversPeriodStart ?? null,
      coversPeriodEnd: input.coversPeriodEnd ?? null,
      note: input.note?.trim() || null,
      status: "open",
      method: "venmo",
    })
    .returning({
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
    });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: input.organizationId,
    action: "payment_request.raised",
    entityType: "payment_request",
    entityId: inserted[0]!.publicId,
    metadata: { amountCents: input.amountCents, dueOn: input.dueOn, reference },
  });

  return inserted[0]!;
}

export type ConfirmResult =
  | { ok: true; alreadyConfirmed: boolean; paymentPublicId: string }
  | { ok: false; reason: "not_found" | "not_confirmable" };

/**
 * Record that money actually arrived.
 *
 * Order is deliberate: claim the request first with a conditional update, and
 * only write the ledger row if this call is the one that won. A concurrent
 * second call matches zero rows and returns `alreadyConfirmed` instead of
 * inserting a second payment for the same invoice.
 */
export async function confirmPaymentReceived(
  ctx: AdminContext,
  db: Database,
  requestPublicId: string,
  input: { method: PaymentMethod; receivedOn: string; note?: string },
): Promise<ConfirmResult> {
  const rows = await db
    .select({
      id: paymentRequests.id,
      clientId: paymentRequests.clientId,
      amountCents: paymentRequests.amountCents,
      currency: paymentRequests.currency,
      status: paymentRequests.status,
      subscriptionId: paymentRequests.subscriptionId,
      coversPeriodStart: paymentRequests.coversPeriodStart,
      coversPeriodEnd: paymentRequests.coversPeriodEnd,
      paymentId: paymentRequests.paymentId,
      organizationId: clients.organizationId,
    })
    .from(paymentRequests)
    .innerJoin(clients, eq(paymentRequests.clientId, clients.id))
    .where(eq(paymentRequests.publicId, requestPublicId))
    .limit(1);

  const request = rows[0];
  if (!request) return { ok: false, reason: "not_found" };

  // Already settled: report it rather than recording a second payment.
  if (request.status === "paid") {
    const existing = await db
      .select({ publicId: payments.publicId })
      .from(payments)
      .where(eq(payments.id, request.paymentId!))
      .limit(1);
    return {
      ok: true,
      alreadyConfirmed: true,
      paymentPublicId: existing[0]?.publicId ?? "",
    };
  }

  if (!["open", "overdue", "awaiting_confirmation"].includes(request.status)) {
    return { ok: false, reason: "not_confirmable" };
  }

  const now = new Date();

  // The ledger row comes first so the request can point at it, but it carries
  // an idempotency key derived from the request: a retry that races past the
  // claim below cannot create a second one.
  const idempotencyKey = `payment_request:${requestPublicId}`;

  const existingLedger = await db
    .select({ id: payments.id, publicId: payments.publicId })
    .from(payments)
    .where(eq(payments.idempotencyKey, idempotencyKey))
    .limit(1);

  let paymentId: string;
  let paymentPublicId: string;

  if (existingLedger[0]) {
    paymentId = existingLedger[0].id;
    paymentPublicId = existingLedger[0].publicId;
  } else {
    const ledger = await db
      .insert(payments)
      .values({
        publicId: newPublicId(),
        clientId: request.clientId,
        subscriptionId: request.subscriptionId,
        amountCents: request.amountCents,
        currency: request.currency,
        method: input.method,
        idempotencyKey,
        coversPeriodStart: request.coversPeriodStart,
        coversPeriodEnd: request.coversPeriodEnd,
        receivedOn: input.receivedOn,
        recordedBy: ctx.userId,
        status: "recorded",
        note: input.note?.trim() || null,
      })
      .returning({ id: payments.id, publicId: payments.publicId });
    paymentId = ledger[0]!.id;
    paymentPublicId = ledger[0]!.publicId;
  }

  // Conditional claim. `status <> 'paid'` is what makes a double submission
  // safe; the schema additionally refuses 'paid' without both confirmation
  // columns set.
  const claimed = await db
    .update(paymentRequests)
    .set({
      status: "paid",
      confirmedAt: now,
      confirmedByUserId: ctx.userId,
      paymentId,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentRequests.id, request.id),
        sql`${paymentRequests.status} <> 'paid'`,
      ),
    )
    .returning({ id: paymentRequests.id });

  // Payment settles the account, so any dunning pause is lifted here too.
  await db
    .update(clients)
    .set({
      managementState: "managed",
      managementPausedAt: null,
      managementPausedReason: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(clients.id, request.clientId),
        sql`${clients.managementState} <> 'managed'`,
      ),
    );

  // Money arriving is what turns the features on. Idempotent and first-write-
  // wins, so confirming a second month does not reset the unlock date — and
  // safe to call on every confirmation rather than only the first, which
  // removes the need for this code to know which one it is looking at.
  await unlockClientFeatures(db, request.clientId, {
    actorUserId: ctx.userId,
    reason: "payment_confirmed",
  });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: request.organizationId,
    action: "payment.confirmed",
    entityType: "payment_request",
    entityId: requestPublicId,
    metadata: {
      amountCents: request.amountCents,
      method: input.method,
      receivedOn: input.receivedOn,
    },
  });

  return {
    ok: true,
    alreadyConfirmed: claimed.length === 0,
    paymentPublicId,
  };
}

/** Payment requests for one client, newest first. */
export async function listClientPaymentRequests(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
) {
  return db
    .select({
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      currency: paymentRequests.currency,
      dueOn: paymentRequests.dueOn,
      status: paymentRequests.status,
      dunningStage: paymentRequests.dunningStage,
      initiatedAt: paymentRequests.initiatedAt,
      confirmedAt: paymentRequests.confirmedAt,
      note: paymentRequests.note,
      createdAt: paymentRequests.createdAt,
    })
    .from(paymentRequests)
    .innerJoin(clients, eq(paymentRequests.clientId, clients.id))
    .where(eq(clients.organizationId, organizationId))
    .orderBy(desc(paymentRequests.createdAt));
}

export interface OverdueRow {
  publicId: string;
  reference: string;
  amountCents: number;
  dueOn: string | null;
  status: string;
  dunningStage: string;
  daysOverdue: number;
  organizationName: string;
  clientPublicId: string;
  /** True when the client has said they paid and must not be chased. */
  awaitingConfirmation: boolean;
}

/**
 * The operator's chase list.
 *
 * `awaiting_confirmation` rows are INCLUDED but flagged, not hidden. The
 * non-negotiable is that such a client is never *chased* — the dunning ladder
 * suppresses them, and it is the job that sends reminders. The operator still
 * needs to see them, because that state means someone is waiting on *us* to
 * confirm their money arrived, which is a task, not a debt.
 */
export async function listOverduePaymentRequests(
  _ctx: AdminContext,
  db: Database,
  now: Date = new Date(),
): Promise<OverdueRow[]> {
  const today = now.toISOString().slice(0, 10);

  const rows = await db
    .select({
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      dueOn: paymentRequests.dueOn,
      status: paymentRequests.status,
      dunningStage: paymentRequests.dunningStage,
      organizationName: organizations.name,
      clientPublicId: clients.publicId,
    })
    .from(paymentRequests)
    .innerJoin(clients, eq(paymentRequests.clientId, clients.id))
    .innerJoin(organizations, eq(clients.organizationId, organizations.id))
    .where(
      and(
        inArray(paymentRequests.status, [
          "open",
          "overdue",
          "awaiting_confirmation",
        ]),
        or(
          lte(paymentRequests.dueOn, today),
          eq(paymentRequests.status, "awaiting_confirmation"),
        ),
        isNull(clients.archivedAt),
      ),
    )
    .orderBy(paymentRequests.dueOn);

  return rows.map((r) => ({
    ...r,
    daysOverdue: r.dueOn ? daysOverdue(new Date(`${r.dueOn}T00:00:00Z`), now) : 0,
    awaitingConfirmation: r.status === "awaiting_confirmation",
  }));
}
