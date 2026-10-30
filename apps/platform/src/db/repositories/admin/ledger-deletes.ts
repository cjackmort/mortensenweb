import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  expenses,
  organizations,
  paymentRequests,
  payments,
  users,
} from "@/db/schema";
import type { AdminContext } from "../context";
import type { DateRange } from "./finance";

/**
 * Deleting from the ledger.
 *
 * The operator asked for deleting to be easy, and the books have to stay
 * right when it is. Both kinds of row are hidden rather than removed, and for
 * the same reason — something would otherwise put them back:
 *
 * - **Income (`payments`)** is voided: `status = 'void'` plus who, when and
 *   why. A reversing adjustment was the other option and the wrong one here:
 *   nothing that totals `payments` reads `payment_adjustments`, so every total
 *   on the page and the client's own billing history would still count the
 *   money. Every reader already counts `recorded` rows only, so a void drops
 *   out of all of them at once with nothing to subtract anywhere.
 *
 * - **Expenses** get `deleted_at`. Removing the row outright was what the old
 *   "Remove" did, and an automatic row came back within the hour: the fee job
 *   and the monthly-repeat job both re-create a row whose derived public id is
 *   missing. A hidden row still holds its id, so neither job writes it again.
 *
 * Every delete writes an `audit_log` entry, so "where did that $49 go" has an
 * answer that is not "someone clicked something".
 */

export type DeleteExpenseResult = "deleted" | "already" | "not_found";

/**
 * Take an expense out of the ledger.
 *
 * Deleting the row that controls a monthly series also ends the series: a
 * hidden row that kept repeating would add months nobody can see the source of.
 */
export async function deleteExpense(
  ctx: AdminContext,
  db: Database,
  publicId: string,
): Promise<DeleteExpenseResult> {
  const [row] = await db
    .select({
      id: expenses.id,
      deletedAt: expenses.deletedAt,
      description: expenses.description,
      category: expenses.category,
      amountCents: expenses.amountCents,
      occurredOn: expenses.occurredOn,
      isRecurring: expenses.isRecurring,
      recordedBy: expenses.recordedBy,
    })
    .from(expenses)
    .where(eq(expenses.publicId, publicId))
    .limit(1);

  if (!row) return "not_found";
  if (row.deletedAt) return "already";

  const claimed = await db
    .update(expenses)
    .set({ deletedAt: new Date(), deletedBy: ctx.userId, isRecurring: false })
    .where(and(eq(expenses.id, row.id), isNull(expenses.deletedAt)))
    .returning({ id: expenses.id });
  if (claimed.length === 0) return "already";

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "expense.deleted",
    entityType: "expense",
    entityId: publicId,
    metadata: {
      description: row.description,
      category: row.category,
      amountCents: row.amountCents,
      occurredOn: row.occurredOn,
      endedSeries: row.isRecurring,
      automatic: row.recordedBy === null,
    },
  });

  return "deleted";
}

export type VoidPaymentResult =
  | {
      ok: true;
      alreadyVoid: boolean;
      /** The invoice this payment had settled, now unpaid again. */
      reopenedInvoice: string | null;
    }
  | { ok: false; reason: "not_found" };

/**
 * Take a payment out of the ledger.
 *
 * - **Stripe.** The row keeps its `stripe_invoice:` idempotency key, so the
 *   hourly resync and a redelivered `invoice.paid` find it and record nothing
 *   (`recordInvoicePayment` checks the key, not the status). The fee job looks
 *   for fees on `recorded` payments only, so it stops looking for this one.
 * - **The invoice it paid** is unpaid again: `open`, or `awaiting_confirmation`
 *   when the client had said they paid, because that is still true. Leaving it
 *   `paid` would show the client as paid up with no money behind it. A hand-
 *   confirmed payment's `payment_request:` key is moved aside, so marking that
 *   invoice paid again records a fresh row instead of finding this one.
 * - **Features are never locked.** Unlocking is first-write-wins and nothing
 *   here touches it, the management state, or an extra change already
 *   credited. Taking a client's portal away is a decision made on their page,
 *   never a side effect of tidying the books.
 *
 * Idempotent: a second call reports `alreadyVoid` and writes nothing.
 */
export async function voidPayment(
  ctx: AdminContext,
  db: Database,
  publicId: string,
  { reason }: { reason?: string },
): Promise<VoidPaymentResult> {
  const [row] = await db
    .select({
      id: payments.id,
      status: payments.status,
      amountCents: payments.amountCents,
      currency: payments.currency,
      method: payments.method,
      provider: payments.provider,
      providerReference: payments.providerReference,
      idempotencyKey: payments.idempotencyKey,
      receivedOn: payments.receivedOn,
      organizationId: clients.organizationId,
    })
    .from(payments)
    .innerJoin(clients, eq(clients.id, payments.clientId))
    .where(eq(payments.publicId, publicId))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "void") return { ok: true, alreadyVoid: true, reopenedInvoice: null };

  const now = new Date();
  const why = reason?.trim() || null;
  const releasesKey = row.idempotencyKey?.startsWith("payment_request:") ?? false;

  const claimed = await db
    .update(payments)
    .set({
      status: "void",
      voidedAt: now,
      voidedBy: ctx.userId,
      voidReason: why,
      ...(releasesKey ? { idempotencyKey: `void:${publicId}:${row.idempotencyKey}` } : {}),
    })
    .where(and(eq(payments.id, row.id), eq(payments.status, "recorded")))
    .returning({ id: payments.id });

  if (claimed.length === 0) return { ok: true, alreadyVoid: true, reopenedInvoice: null };

  const reopened = await db
    .update(paymentRequests)
    .set({
      status: sql`CASE WHEN ${paymentRequests.initiatedAt} IS NOT NULL
        THEN 'awaiting_confirmation'::payment_request_status
        ELSE 'open'::payment_request_status END`,
      confirmedAt: null,
      confirmedByUserId: null,
      paymentId: null,
      updatedAt: now,
    })
    .where(and(eq(paymentRequests.paymentId, row.id), eq(paymentRequests.status, "paid")))
    .returning({ reference: paymentRequests.reference });

  const reopenedInvoice = reopened[0]?.reference ?? null;

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: row.organizationId,
    action: "payment.voided",
    entityType: "payment",
    entityId: publicId,
    metadata: {
      amountCents: row.amountCents,
      currency: row.currency,
      method: row.method,
      provider: row.provider,
      providerReference: row.providerReference,
      receivedOn: row.receivedOn,
      reason: why,
      reopenedInvoice,
    },
  });

  return { ok: true, alreadyVoid: false, reopenedInvoice };
}

export interface LedgerRowRef {
  kind: "income" | "expense";
  publicId: string;
}

export interface BulkDeleteResult {
  deletedIncome: number;
  deletedExpenses: number;
  reopenedInvoices: string[];
  /** Ids that matched nothing, or were already deleted. */
  notFound: number;
}

/** The most rows one bulk delete takes: a month of the ledger, not a purge. */
export const MAX_BULK_DELETE = 200;

/** Delete several ledger rows, each exactly as deleting it alone would. */
export async function deleteLedgerRows(
  ctx: AdminContext,
  db: Database,
  rows: LedgerRowRef[],
  reason?: string,
): Promise<BulkDeleteResult> {
  if (rows.length > MAX_BULK_DELETE) {
    throw new Error(`Delete at most ${MAX_BULK_DELETE} rows at a time.`);
  }

  const result: BulkDeleteResult = {
    deletedIncome: 0,
    deletedExpenses: 0,
    reopenedInvoices: [],
    notFound: 0,
  };

  for (const ref of rows) {
    if (ref.kind === "income") {
      const voided = await voidPayment(ctx, db, ref.publicId, { reason });
      if (!voided.ok || voided.alreadyVoid) {
        result.notFound += 1;
        continue;
      }
      result.deletedIncome += 1;
      if (voided.reopenedInvoice) result.reopenedInvoices.push(voided.reopenedInvoice);
      continue;
    }

    const deleted = await deleteExpense(ctx, db, ref.publicId);
    if (deleted === "deleted") result.deletedExpenses += 1;
    else result.notFound += 1;
  }

  return result;
}

export interface DeletedLedgerRow {
  kind: "income" | "expense";
  publicId: string;
  date: string;
  label: string;
  amountCents: number;
  currency: string;
  deletedAt: Date;
  deletedBy: string | null;
  reason: string | null;
}

/** What was deleted from a date range, newest deletion first. */
export async function listDeletedLedgerRows(
  _ctx: AdminContext,
  db: Database,
  range: DateRange,
): Promise<DeletedLedgerRow[]> {
  const income = await db
    .select({
      publicId: payments.publicId,
      date: payments.receivedOn,
      label: organizations.name,
      amountCents: payments.amountCents,
      currency: payments.currency,
      deletedAt: payments.voidedAt,
      byName: users.name,
      byEmail: users.email,
      reason: payments.voidReason,
    })
    .from(payments)
    .innerJoin(clients, eq(clients.id, payments.clientId))
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .leftJoin(users, eq(users.id, payments.voidedBy))
    .where(
      and(
        eq(payments.status, "void"),
        isNotNull(payments.voidedAt),
        gte(payments.receivedOn, range.from),
        lt(payments.receivedOn, range.to),
      ),
    );

  const outgoing = await db
    .select({
      publicId: expenses.publicId,
      date: expenses.occurredOn,
      label: expenses.description,
      amountCents: expenses.amountCents,
      currency: expenses.currency,
      deletedAt: expenses.deletedAt,
      byName: users.name,
      byEmail: users.email,
    })
    .from(expenses)
    .leftJoin(users, eq(users.id, expenses.deletedBy))
    .where(
      and(
        isNotNull(expenses.deletedAt),
        gte(expenses.occurredOn, range.from),
        lt(expenses.occurredOn, range.to),
      ),
    )
    .orderBy(desc(expenses.deletedAt));

  const rows: DeletedLedgerRow[] = [
    ...income.map((p) => ({
      kind: "income" as const,
      publicId: p.publicId,
      date: p.date,
      label: p.label,
      amountCents: p.amountCents,
      currency: p.currency,
      deletedAt: p.deletedAt!,
      deletedBy: p.byName ?? p.byEmail ?? null,
      reason: p.reason,
    })),
    ...outgoing.map((e) => ({
      kind: "expense" as const,
      publicId: e.publicId,
      date: e.date,
      label: e.label,
      amountCents: e.amountCents,
      currency: e.currency,
      deletedAt: e.deletedAt!,
      deletedBy: e.byName ?? e.byEmail ?? null,
      reason: null,
    })),
  ];

  return rows.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}
