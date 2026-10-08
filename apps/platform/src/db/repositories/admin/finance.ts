import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, expenses, organizations, payments, subscriptions } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { newPublicId } from "@/lib/ids";
import type { AdminContext } from "../context";

/**
 * The agency's own money: its subscription roster, revenue actually received,
 * and its operating expenses. Separate from billing.ts, which is money moving
 * between a client and the agency — this is money moving between the agency
 * and everyone else, which no `AdminContext`-scoped tenant boundary applies
 * to.
 *
 * ## The ledger is two tables read together
 *
 * Money in is `payments`, money out is `expenses`, and they stay two tables
 * (see the schema comment on `expenses`). The ledger reads both, so a payment
 * appears as income the moment it is recorded — by the Stripe receiver, by a
 * Square webhook, or by the operator confirming a Venmo — with nothing copied
 * across that could drift from the original.
 *
 * Only `recorded` payments count. `void` exists so a correction is never a
 * subtraction someone has to remember, and a demo payment is not money.
 *
 * Months are the business's calendar months (`businessDate`), not UTC ones.
 * A UTC month ends at 6pm in Denver, which put the last evening's payments in
 * next month's total.
 */

export type LedgerCategory =
  | "software"
  | "hosting"
  | "contractor"
  | "marketing"
  | "equipment"
  | "fees"
  | "other";

export async function listActiveSubscriptions(_ctx: AdminContext, db: Database) {
  return db
    .select({
      publicId: subscriptions.publicId,
      clientPublicId: clients.publicId,
      organizationName: organizations.name,
      monthlyPriceCents: subscriptions.monthlyPriceCents,
      discountLabel: subscriptions.discountLabel,
      discountedPriceCents: subscriptions.discountedPriceCents,
      discountEndsAt: subscriptions.discountEndsAt,
      currency: subscriptions.currency,
      billingDay: subscriptions.billingDay,
      provider: subscriptions.provider,
      startedOn: subscriptions.startedOn,
    })
    .from(subscriptions)
    .innerJoin(clients, eq(subscriptions.clientId, clients.id))
    .innerJoin(organizations, eq(clients.organizationId, organizations.id))
    .where(eq(subscriptions.status, "active"))
    .orderBy(organizations.name);
}

/** A half-open range of `YYYY-MM-DD` dates: `from` inclusive, `to` exclusive. */
export interface DateRange {
  from: string;
  to: string;
}

/** The business-calendar month `YYYY-MM`, as a range. */
export function monthRange(yearMonth: string): DateRange {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${yearMonth}-01`, to: `${next}-01` };
}

export function yearRange(year: number): DateRange {
  return { from: `${year}-01-01`, to: `${year + 1}-01-01` };
}

/** The current business month, `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  return businessDate(now).slice(0, 7);
}

const COUNTED_PAYMENT = and(eq(payments.status, "recorded"), eq(payments.isDemo, false));

/** Confirmed money received this business month. */
export async function sumPaymentsReceivedInMonth(
  _ctx: AdminContext,
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  return (await periodTotals(db, monthRange(currentMonth(now)))).incomeCents;
}

export interface NewExpenseInput {
  description: string;
  category: LedgerCategory;
  amountCents: number;
  occurredOn: string;
  isRecurring: boolean;
  note?: string;
}

export async function addExpense(ctx: AdminContext, db: Database, input: NewExpenseInput) {
  const [row] = await db
    .insert(expenses)
    .values({
      publicId: newPublicId(),
      description: input.description,
      category: input.category,
      amountCents: input.amountCents,
      occurredOn: input.occurredOn,
      isRecurring: input.isRecurring,
      note: input.note || null,
      // What marks a row as typed by a person. Automatic rows leave it null;
      // see `ledger-automation.ts`.
      recordedBy: ctx.userId,
    })
    .returning();
  return row;
}

export async function deleteExpense(_ctx: AdminContext, db: Database, publicId: string) {
  await db.delete(expenses).where(eq(expenses.publicId, publicId));
}

/**
 * End a monthly series. The rows already made stay: they are months that
 * were really paid for.
 */
export async function stopRecurringExpense(
  _ctx: AdminContext,
  db: Database,
  publicId: string,
): Promise<boolean> {
  const stopped = await db
    .update(expenses)
    .set({ isRecurring: false })
    .where(and(eq(expenses.publicId, publicId), eq(expenses.isRecurring, true)))
    .returning({ id: expenses.id });
  return stopped.length > 0;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export type LedgerEntry =
  | {
      kind: "income";
      key: string;
      date: string;
      clientPublicId: string;
      counterparty: string;
      method: string;
      reference: string | null;
      note: string | null;
      amountCents: number;
      currency: string;
    }
  | {
      kind: "expense";
      key: string;
      publicId: string;
      date: string;
      category: LedgerCategory;
      description: string;
      note: string | null;
      amountCents: number;
      currency: string;
      /** The row the operator marked monthly. */
      isRecurring: boolean;
      /** Written by the platform: a Stripe fee or a month of a series. */
      automatic: boolean;
    };

/** Every income and expense row in a date range, newest first. */
export async function ledgerEntries(
  _ctx: AdminContext,
  db: Database,
  range: DateRange,
): Promise<LedgerEntry[]> {
  const income = await db
    .select({
      publicId: payments.publicId,
      date: payments.receivedOn,
      createdAt: payments.createdAt,
      clientPublicId: clients.publicId,
      counterparty: organizations.name,
      method: payments.method,
      reference: payments.providerReference,
      note: payments.note,
      amountCents: payments.amountCents,
      currency: payments.currency,
    })
    .from(payments)
    .innerJoin(clients, eq(clients.id, payments.clientId))
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(
      and(COUNTED_PAYMENT, gte(payments.receivedOn, range.from), lt(payments.receivedOn, range.to)),
    );

  const outgoing = await db
    .select({
      publicId: expenses.publicId,
      date: expenses.occurredOn,
      createdAt: expenses.createdAt,
      category: expenses.category,
      description: expenses.description,
      note: expenses.note,
      amountCents: expenses.amountCents,
      currency: expenses.currency,
      isRecurring: expenses.isRecurring,
      recordedBy: expenses.recordedBy,
    })
    .from(expenses)
    .where(and(gte(expenses.occurredOn, range.from), lt(expenses.occurredOn, range.to)));

  const entries: (LedgerEntry & { createdAt: Date })[] = [
    ...income.map((p) => ({
      kind: "income" as const,
      key: `p:${p.publicId}`,
      date: p.date,
      createdAt: p.createdAt,
      clientPublicId: p.clientPublicId,
      counterparty: p.counterparty,
      method: p.method,
      reference: p.reference,
      note: p.note,
      amountCents: p.amountCents,
      currency: p.currency,
    })),
    ...outgoing.map((e) => ({
      kind: "expense" as const,
      key: `e:${e.publicId}`,
      publicId: e.publicId,
      date: e.date,
      createdAt: e.createdAt,
      category: e.category,
      description: e.description,
      note: e.note,
      amountCents: e.amountCents,
      currency: e.currency,
      isRecurring: e.isRecurring,
      automatic: e.recordedBy === null,
    })),
  ];

  // Same day: the later write first, so a fee sits directly above the
  // payment it was charged on.
  entries.sort((a, b) =>
    a.date === b.date ? b.createdAt.getTime() - a.createdAt.getTime() : a.date < b.date ? 1 : -1,
  );

  return entries.map(({ createdAt: _createdAt, ...entry }) => entry as LedgerEntry);
}

export interface PeriodTotals {
  incomeCents: number;
  /** Payment processing: Stripe's fees, and anything else filed as `fees`. */
  feesCents: number;
  /** Every other expense. */
  expensesCents: number;
  /** Income less fees less expenses. Before tax, and not a bank balance. */
  profitCents: number;
}

async function periodTotals(db: Database, range: DateRange): Promise<PeriodTotals> {
  const [income] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(
      and(COUNTED_PAYMENT, gte(payments.receivedOn, range.from), lt(payments.receivedOn, range.to)),
    );

  const [out] = await db
    .select({
      fees: sql<number>`coalesce(sum(case when ${expenses.category} = 'fees' then ${expenses.amountCents} end), 0)::int`,
      other: sql<number>`coalesce(sum(case when ${expenses.category} <> 'fees' then ${expenses.amountCents} end), 0)::int`,
    })
    .from(expenses)
    .where(and(gte(expenses.occurredOn, range.from), lt(expenses.occurredOn, range.to)));

  const incomeCents = Number(income?.total ?? 0);
  const feesCents = Number(out?.fees ?? 0);
  const expensesCents = Number(out?.other ?? 0);
  return {
    incomeCents,
    feesCents,
    expensesCents,
    profitCents: incomeCents - feesCents - expensesCents,
  };
}

export interface LedgerSummary {
  month: PeriodTotals & { yearMonth: string };
  year: PeriodTotals & { year: number };
}

/** The selected month, and the calendar year it falls in, to date. */
export async function ledgerSummary(
  _ctx: AdminContext,
  db: Database,
  yearMonth: string,
): Promise<LedgerSummary> {
  const year = Number(yearMonth.slice(0, 4));
  const [month, wholeYear] = await Promise.all([
    periodTotals(db, monthRange(yearMonth)),
    periodTotals(db, yearRange(year)),
  ]);
  return { month: { ...month, yearMonth }, year: { ...wholeYear, year } };
}
