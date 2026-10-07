import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, clients, expenses, organizations, payments } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";
import { derivedPublicId } from "@/lib/ids";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { formatCurrency } from "@/lib/payments/venmo";

/**
 * The two kinds of ledger row nobody should have to type.
 *
 * **Stripe's fee on each payment.** Read from the charge's balance
 * transaction, which is the figure Stripe actually deducted, not a rate
 * multiplied out. Pricing varies by card, country and method, and an estimate
 * that is off by a few cents a payment is a reconciliation problem at year
 * end that nobody can trace.
 *
 * **Next month's row of a monthly expense.** `expenses.is_recurring` used to
 * be a display tag. An expense marked monthly now produces one row a month,
 * dated on the same day of the month, until the operator stops it.
 *
 * Both are idempotent through `derivedPublicId`: the public id of an automatic
 * row is derived from what it stands for, so the unique index on
 * `expenses.public_id` turns a second insert, from a retry or an overlapping
 * run, into nothing.
 *
 * Automatic rows have no `recorded_by`. Every row an admin types has one, which
 * is how the page tells the two apart without a column for it.
 */

/** How far back a missed month is still filled in. Bounds a run after a long outage. */
const MAX_CATCH_UP_MONTHS = 12;

/**
 * How far back a Stripe payment is still checked for its fee.
 *
 * A payment whose balance transaction never appears (a fee of zero, or a
 * method that settles without one) would otherwise be looked up on every run
 * forever. Ninety days is far past any card or bank settlement.
 */
const FEE_LOOKBACK_DAYS = 90;
const MAX_FEES_PER_RUN = 25;

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/** `YYYY-MM` plus `n` months. */
export function addMonths(yearMonth: string, n: number): string {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function daysIn(yearMonth: string): number {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The date in `yearMonth` that repeats `dayOfMonth`.
 *
 * Clamped to the month's last day, so an expense entered on the 31st lands on
 * the 30th in September and the 28th in February instead of spilling into the
 * next month, where it would be counted twice in one month and missing from
 * the one before.
 */
export function repeatDate(yearMonth: string, dayOfMonth: number): string {
  const day = Math.min(dayOfMonth, daysIn(yearMonth));
  return `${yearMonth}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Recurring expenses
// ---------------------------------------------------------------------------

export interface RecurringResult {
  series: number;
  created: number;
}

/**
 * Create every month's row that is due and missing, for every monthly expense.
 *
 * A series starts the month after the later of the expense's date and the day
 * it was entered. An expense typed today with last January's date and marked
 * monthly means "this repeats from now on". It does not mean "invent the
 * nine months before I told you about it", and the ledger is what is handed
 * to an accountant.
 *
 * A month's row appears on its day, not on the 1st: the ledger records money
 * that has gone out, not money that will.
 *
 * Generated rows are not themselves recurring. Only the row the operator
 * marked is, so unticking it (`stopRecurringExpense`) ends the series, and
 * deleting a single month does not. Deleting a month while the series still
 * runs brings it back on the next run. That is correct for a charge that
 * still happens; to remove one, stop the series first.
 */
export async function generateRecurringExpenses(
  db: Database,
  now: Date = new Date(),
): Promise<RecurringResult> {
  const today = businessDate(now);
  const thisMonth = today.slice(0, 7);

  const templates = await db
    .select({
      publicId: expenses.publicId,
      description: expenses.description,
      category: expenses.category,
      amountCents: expenses.amountCents,
      currency: expenses.currency,
      occurredOn: expenses.occurredOn,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .where(eq(expenses.isRecurring, true));

  let created = 0;

  for (const template of templates) {
    const datedMonth = template.occurredOn.slice(0, 7);
    const enteredMonth = businessDate(template.createdAt).slice(0, 7);
    const base = datedMonth > enteredMonth ? datedMonth : enteredMonth;

    let month = addMonths(base, 1);
    const earliest = addMonths(thisMonth, -(MAX_CATCH_UP_MONTHS - 1));
    if (month < earliest) month = earliest;

    const dayOfMonth = Number(template.occurredOn.slice(8, 10));
    const rows: (typeof expenses.$inferInsert)[] = [];

    for (; month <= thisMonth; month = addMonths(month, 1)) {
      const date = repeatDate(month, dayOfMonth);
      if (date > today) break;

      rows.push({
        publicId: await derivedPublicId(`recurring:${template.publicId}:${month}`),
        description: template.description,
        category: template.category,
        amountCents: template.amountCents,
        currency: template.currency,
        occurredOn: date,
        isRecurring: false,
        note: `Added automatically: repeats the monthly expense entered for ${template.occurredOn}.`,
        recordedBy: null,
      });
    }

    if (rows.length === 0) continue;

    const inserted = await db
      .insert(expenses)
      .values(rows)
      .onConflictDoNothing({ target: expenses.publicId })
      .returning({ id: expenses.id });
    created += inserted.length;
  }

  return { series: templates.length, created };
}

// ---------------------------------------------------------------------------
// Stripe fees
// ---------------------------------------------------------------------------

export interface FeeResult {
  checked: number;
  recorded: number;
  /** No balance transaction yet: a bank payment still settling. Retried next run. */
  pending: number;
  failed: number;
}

/** The public id of the fee row for one payment. Exported for tests. */
export function feeRowId(paymentId: string): Promise<string> {
  return derivedPublicId(`stripe_fee:${paymentId}`);
}

function idOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return (value as { id?: string }).id ?? null;
}

function balanceTransactionOfCharge(charge: unknown): Stripe.BalanceTransaction | null {
  const bt = (charge as Stripe.Charge | null)?.balance_transaction;
  return bt && typeof bt !== "string" ? bt : null;
}

async function balanceTransactionOfIntent(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<Stripe.BalanceTransaction | null> {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge.balance_transaction"],
  });
  return balanceTransactionOfCharge(intent.latest_charge);
}

/**
 * The balance transaction behind a ledger row's Stripe reference.
 *
 * The reference is whatever the recording path stored: an invoice id for a
 * subscription payment, a payment intent (or, failing that, the Checkout
 * Session) for a one-off. Each leads to the charge by a different route.
 *
 * Null when there is no balance transaction yet. A card charge has one at
 * once; a bank debit only once it settles.
 */
export async function balanceTransactionFor(
  reference: string,
): Promise<Stripe.BalanceTransaction | null> {
  const stripe = requireStripe();

  if (reference.startsWith("in_")) {
    const invoice = await stripe.invoices.retrieve(reference, { expand: ["payments"] });
    const paid = (
      invoice as Stripe.Invoice & {
        payments?: { data: { status?: string; payment?: { payment_intent?: unknown; charge?: unknown } }[] };
      }
    ).payments?.data.find((p) => p.status === "paid");

    const intentId = idOf(paid?.payment?.payment_intent);
    if (intentId) return balanceTransactionOfIntent(stripe, intentId);

    const chargeId = idOf(paid?.payment?.charge);
    if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
      return balanceTransactionOfCharge(charge);
    }
    return null;
  }

  if (reference.startsWith("pi_")) return balanceTransactionOfIntent(stripe, reference);

  if (reference.startsWith("cs_")) {
    const session = await stripe.checkout.sessions.retrieve(reference, {
      expand: ["payment_intent.latest_charge.balance_transaction"],
    });
    const intent = session.payment_intent;
    return intent && typeof intent !== "string"
      ? balanceTransactionOfCharge(intent.latest_charge)
      : null;
  }

  if (reference.startsWith("ch_")) {
    const charge = await stripe.charges.retrieve(reference, { expand: ["balance_transaction"] });
    return balanceTransactionOfCharge(charge);
  }

  return null;
}

/**
 * Record Stripe's fee for every recent Stripe payment that does not have one.
 *
 * One payment failing to resolve is counted and skipped. It must not stop
 * the others, and it is retried on the next run because nothing was written
 * for it.
 */
export async function recordStripeFees(
  db: Database,
  now: Date = new Date(),
): Promise<FeeResult> {
  const result: FeeResult = { checked: 0, recorded: 0, pending: 0, failed: 0 };
  if (!stripeConfigured()) return result;

  const since = businessDate(new Date(now.getTime() - FEE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const candidates = await db
    .select({
      id: payments.id,
      amountCents: payments.amountCents,
      currency: payments.currency,
      providerReference: payments.providerReference,
      receivedOn: payments.receivedOn,
      organizationName: organizations.name,
    })
    .from(payments)
    .innerJoin(clients, eq(clients.id, payments.clientId))
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(
      and(
        eq(payments.provider, "stripe"),
        eq(payments.status, "recorded"),
        eq(payments.isDemo, false),
        // An invoice settled from credit collected nothing, so paid no fee.
        gt(payments.amountCents, 0),
        gte(payments.receivedOn, since),
      ),
    )
    .orderBy(desc(payments.receivedOn))
    .limit(200);

  if (candidates.length === 0) return result;

  const withIds = await Promise.all(
    candidates.map(async (c) => ({ ...c, feeId: await feeRowId(c.id) })),
  );
  const existing = new Set(
    (
      await db
        .select({ publicId: expenses.publicId })
        .from(expenses)
        .where(inArray(expenses.publicId, withIds.map((c) => c.feeId)))
    ).map((r) => r.publicId),
  );

  const missing = withIds.filter((c) => !existing.has(c.feeId) && c.providerReference);

  for (const payment of missing.slice(0, MAX_FEES_PER_RUN)) {
    result.checked += 1;
    try {
      const bt = await balanceTransactionFor(payment.providerReference!);
      if (!bt) {
        result.pending += 1;
        continue;
      }
      // A waived fee is a fact too, but there is nothing to record: the
      // table holds money that went out, and refuses a zero.
      if (bt.fee <= 0) continue;

      const inserted = await db
        .insert(expenses)
        .values({
          publicId: payment.feeId,
          description: `Stripe fee: ${payment.organizationName}`,
          category: "fees",
          amountCents: bt.fee,
          currency: bt.currency.toUpperCase(),
          occurredOn: businessDate(new Date(bt.created * 1000)),
          isRecurring: false,
          note: `On ${formatCurrency(payment.amountCents, payment.currency)} received ${payment.receivedOn} (${payment.providerReference}). Stripe balance transaction ${bt.id}.`,
          recordedBy: null,
        })
        .onConflictDoNothing({ target: expenses.publicId })
        .returning({ id: expenses.id });
      result.recorded += inserted.length;
    } catch (error) {
      result.failed += 1;
      console.error("[ledger] Stripe fee lookup failed", {
        reference: payment.providerReference,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * At most hourly, and only on a tick the scheduler gate already let through.
 *
 * Neither job is something a person is waiting on: a fee or a monthly row
 * appearing within the hour, or with the six-hourly sweep on a quiet day, is
 * as good as instantly. Nothing here runs on its own timer. It rides the cron
 * sweep after `checkGate` has decided the database is worth waking, which is
 * the rule for anything that queries on a schedule (`lib/scheduler/gate.ts`).
 */
const LEDGER_INTERVAL_MS = 60 * 60 * 1000;

export type ScheduledLedgerResult =
  | { ran: false; reason: "too_soon" }
  | { ran: true; recurring: RecurringResult; fees: FeeResult };

export async function runScheduledLedger(
  db: Database,
  now: Date = new Date(),
): Promise<ScheduledLedgerResult> {
  // Gated on the last run's audit row, as `runScheduledReconcile` is: a
  // serverless function remembers nothing between ticks.
  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "ledger.automated"),
        gte(auditLog.createdAt, new Date(now.getTime() - LEDGER_INTERVAL_MS)),
      ),
    )
    .limit(1);
  if (recent.length > 0) return { ran: false, reason: "too_soon" };

  const recurring = await generateRecurringExpenses(db, now);
  const fees = await recordStripeFees(db, now);

  await db.insert(auditLog).values({
    action: "ledger.automated",
    entityType: "ledger",
    entityId: null,
    metadata: { recurring, fees },
  });

  return { ran: true, recurring, fees };
}
