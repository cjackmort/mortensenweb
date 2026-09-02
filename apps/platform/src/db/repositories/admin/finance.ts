import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, expenses, organizations, payments, subscriptions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import type { AdminContext } from "../context";

/**
 * The agency's own money: its subscription roster, revenue actually received,
 * and its operating expenses. Separate from billing.ts, which is money moving
 * between a client and the agency — this is money moving between the agency
 * and everyone else, which no `AdminContext`-scoped tenant boundary applies
 * to.
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

/** UTC month/year boundaries as `YYYY-MM-DD`, matching how `date` columns compare. */
function monthBounds(now: Date) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10),
  };
}

function yearBounds(now: Date) {
  const y = now.getUTCFullYear();
  return {
    start: new Date(Date.UTC(y, 0, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(y + 1, 0, 1)).toISOString().slice(0, 10),
  };
}

/**
 * Confirmed money received this calendar month. `recorded` only — `void`
 * exists precisely so a correction never has to be subtracted by hand from a
 * sum like this one.
 */
export async function sumPaymentsReceivedInMonth(
  _ctx: AdminContext,
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const { start, end } = monthBounds(now);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents}), 0)` })
    .from(payments)
    .where(
      and(
        eq(payments.status, "recorded"),
        gte(payments.receivedOn, start),
        lt(payments.receivedOn, end),
      ),
    );
  return Number(row?.total ?? 0);
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
      recordedBy: ctx.userId,
    })
    .returning();
  return row;
}

export async function listExpenses(_ctx: AdminContext, db: Database, limit = 100) {
  return db.select().from(expenses).orderBy(desc(expenses.occurredOn)).limit(limit);
}

export async function deleteExpense(_ctx: AdminContext, db: Database, publicId: string) {
  await db.delete(expenses).where(eq(expenses.publicId, publicId));
}

/** This month's and this tax year's expense totals — the two numbers the ledger exists for. */
export async function expenseTotals(_ctx: AdminContext, db: Database, now: Date = new Date()) {
  const month = monthBounds(now);
  const year = yearBounds(now);

  const [monthRow] = await db
    .select({ total: sql<number>`coalesce(sum(${expenses.amountCents}), 0)` })
    .from(expenses)
    .where(and(gte(expenses.occurredOn, month.start), lt(expenses.occurredOn, month.end)));

  const [yearRow] = await db
    .select({ total: sql<number>`coalesce(sum(${expenses.amountCents}), 0)` })
    .from(expenses)
    .where(and(gte(expenses.occurredOn, year.start), lt(expenses.occurredOn, year.end)));

  return {
    monthCents: Number(monthRow?.total ?? 0),
    yearCents: Number(yearRow?.total ?? 0),
    taxYear: now.getUTCFullYear(),
  };
}
