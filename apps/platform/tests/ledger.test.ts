import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { businessDate } from "@/lib/billing/period";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The ledger, against a real database.
 *
 * What goes wrong with books kept by a machine:
 *
 *  - a payment that arrived never showing as income
 *  - a fee recorded twice because the job ran twice, or estimated instead of
 *    read from Stripe
 *  - a monthly expense skipping a month, landing twice in one, or backfilling
 *    months nobody asked for
 *  - a series that cannot be stopped
 *  - a CSV that shifts columns, or runs a formula in the accountant's sheet
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let clientId: string;

/** The fake Stripe: balance transactions by payment intent. */
const stripeState = {
  balanceTransactions: new Map<string, unknown>(),
  failingIntents: new Set<string>(),
};

function bt(fee: number, id = "txn_1") {
  return {
    id,
    object: "balance_transaction",
    amount: 100,
    fee,
    net: 100 - fee,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
  };
}

function intent(id: string) {
  if (stripeState.failingIntents.has(id)) throw new Error("Stripe is down");
  return {
    id,
    latest_charge: { id: `ch_for_${id}`, balance_transaction: stripeState.balanceTransactions.get(id) ?? null },
  };
}

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>(
    "@/lib/payments/stripe",
  );
  return {
    ...actual,
    requireStripe: () =>
      ({
        invoices: {
          // A subscription invoice names its payment intent under `payments`.
          retrieve: async (id: string) => ({
            id,
            payments: {
              data: [
                { status: "paid", payment: { type: "payment_intent", payment_intent: `pi_of_${id}` } },
              ],
            },
          }),
        },
        paymentIntents: { retrieve: async (id: string) => intent(id) },
        checkout: {
          sessions: { retrieve: async (id: string) => ({ id, payment_intent: intent(`pi_of_${id}`) }) },
        },
        charges: { retrieve: async () => ({ balance_transaction: null }) },
      }) as never,
  };
});

const { confirmPaymentReceived, raisePaymentRequest } = await import(
  "@/db/repositories/admin/billing"
);
const finance = await import("@/db/repositories/admin/finance");
const automation = await import("@/db/repositories/admin/ledger-automation");
const { csvText, ledgerCsv } = await import("@/lib/finance/ledger-csv");

const today = () => businessDate(new Date());

async function stripePayment(reference: string, amountCents = 100) {
  return (
    await db
      .insert(payments)
      .values({
        publicId: newPublicId(),
        clientId,
        amountCents,
        method: "stripe",
        provider: "stripe",
        providerReference: reference,
        idempotencyKey: `stripe_invoice:${reference}`,
        receivedOn: today(),
        status: "recorded",
      })
      .returning()
  )[0]!;
}

async function feeRows() {
  return db.select().from(expenses).where(eq(expenses.category, "fees"));
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";

  const adminUser = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "ops@example.test", role: "admin", status: "active" })
      .returning()
  )[0]!;
  admin = adminContextFrom({
    userId: adminUser.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(expenses);
  await db.delete(paymentRequests);
  await db.delete(payments);
  await db.delete(clients);
  await db.delete(organizations);
  stripeState.balanceTransactions.clear();
  stripeState.failingIntents.clear();

  const org = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Scott Mortensen Fine Arts",
        slug: `smfa-${Math.random().toString(36).slice(2, 8)}`,
        kind: "client",
      })
      .returning()
  )[0]!;
  clientId = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id })
      .returning()
  )[0]!.id;
});

describe("money in", () => {
  it("shows a confirmed Venmo payment as income, by client and date", async () => {
    const org = (await db.select().from(organizations))[0]!;
    const request = await raisePaymentRequest(admin, db, {
      organizationId: org.id,
      amountCents: 100,
      dueOn: "2026-10-31",
    });
    await confirmPaymentReceived(admin, db, request.publicId, {
      method: "venmo",
      receivedOn: "2026-10-07",
    });

    const entries = await finance.ledgerEntries(admin, db, finance.monthRange("2026-10"));
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "income",
        date: "2026-10-07",
        counterparty: "Scott Mortensen Fine Arts",
        method: "venmo",
        amountCents: 100,
      }),
    );

    const summary = await finance.ledgerSummary(admin, db, "2026-10");
    expect(summary.month.incomeCents).toBe(100);
    expect(summary.year.incomeCents).toBe(100);
  });

  it("does not count a voided or demo payment", async () => {
    await db.insert(payments).values([
      { publicId: newPublicId(), clientId, amountCents: 500, method: "cash", receivedOn: "2026-10-03", status: "void" },
      { publicId: newPublicId(), clientId, amountCents: 700, method: "cash", receivedOn: "2026-10-03", isDemo: true },
    ]);

    const summary = await finance.ledgerSummary(admin, db, "2026-10");
    expect(summary.month.incomeCents).toBe(0);
    expect(await finance.ledgerEntries(admin, db, finance.monthRange("2026-10"))).toHaveLength(0);
  });
});

describe("Stripe fees", () => {
  it("records the fee Stripe actually charged, once", async () => {
    // The real first payment: $1.00, Stripe kept $0.33.
    const payment = await stripePayment("in_first");
    stripeState.balanceTransactions.set("pi_of_in_first", bt(33));

    const first = await automation.recordStripeFees(db);
    const second = await automation.recordStripeFees(db);

    expect(first.recorded).toBe(1);
    expect(second.recorded).toBe(0);

    const fees = await feeRows();
    expect(fees).toHaveLength(1);
    expect(fees[0]!.amountCents).toBe(33);
    expect(fees[0]!.recordedBy).toBeNull();
    expect(fees[0]!.publicId).toBe(await automation.feeRowId(payment.id));
    expect(fees[0]!.description).toBe("Stripe fee: Scott Mortensen Fine Arts");

    const summary = await finance.ledgerSummary(admin, db, today().slice(0, 7));
    expect(summary.month).toMatchObject({ incomeCents: 100, feesCents: 33, profitCents: 67 });
  });

  it("waits for a payment that has not settled, then records it", async () => {
    await stripePayment("in_ach");

    const before = await automation.recordStripeFees(db);
    expect(before.pending).toBe(1);
    expect(await feeRows()).toHaveLength(0);

    stripeState.balanceTransactions.set("pi_of_in_ach", bt(80));
    await automation.recordStripeFees(db);
    expect((await feeRows())[0]!.amountCents).toBe(80);
  });

  it("finds the fee for a one-off checkout by its payment intent", async () => {
    await stripePayment("pi_oneoff");
    stripeState.balanceTransactions.set("pi_oneoff", bt(59));

    await automation.recordStripeFees(db);

    expect((await feeRows())[0]!.amountCents).toBe(59);
  });

  it("keeps going when one payment cannot be read", async () => {
    await stripePayment("in_broken");
    await stripePayment("in_fine");
    stripeState.failingIntents.add("pi_of_in_broken");
    stripeState.balanceTransactions.set("pi_of_in_fine", bt(33));

    const result = await automation.recordStripeFees(db);

    expect(result).toMatchObject({ recorded: 1, failed: 1 });
    expect(await feeRows()).toHaveLength(1);
  });

  it("ignores an invoice that collected nothing", async () => {
    await stripePayment("in_credit", 0);

    const result = await automation.recordStripeFees(db);

    expect(result.checked).toBe(0);
  });
});

describe("monthly expenses", () => {
  async function monthly(occurredOn: string, createdAt: string, description = "Figma") {
    return finance
      .addExpense(admin, db, {
        description,
        category: "software",
        amountCents: 1500,
        occurredOn,
        isRecurring: true,
      })
      .then(async (row) => {
        await db.update(expenses).set({ createdAt: new Date(createdAt) }).where(eq(expenses.id, row!.id));
        return row!;
      });
  }

  async function datesOf(description: string) {
    return (await db.select().from(expenses).where(eq(expenses.description, description)))
      .map((r) => r.occurredOn)
      .sort();
  }

  it("adds each month on its day, clamped to short months, and only once", async () => {
    await monthly("2026-07-31", "2026-07-31T18:00:00Z");
    const now = new Date("2026-10-06T18:00:00Z");

    await automation.generateRecurringExpenses(db, now);
    await automation.generateRecurringExpenses(db, now);

    // September has 30 days; October's 31st has not happened yet.
    expect(await datesOf("Figma")).toEqual(["2026-07-31", "2026-08-31", "2026-09-30"]);

    const generated = (await db.select().from(expenses)).filter((r) => !r.isRecurring);
    expect(generated.every((r) => r.recordedBy === null)).toBe(true);
  });

  it("stops when the operator stops it, keeping the months already recorded", async () => {
    const template = await monthly("2026-08-15", "2026-08-15T18:00:00Z");
    await automation.generateRecurringExpenses(db, new Date("2026-09-20T18:00:00Z"));

    expect(await finance.stopRecurringExpense(admin, db, template.publicId)).toBe(true);
    await automation.generateRecurringExpenses(db, new Date("2026-12-20T18:00:00Z"));

    expect(await datesOf("Figma")).toEqual(["2026-08-15", "2026-09-15"]);
  });

  it("starts from when it was entered, not from an old date typed on it", async () => {
    // Typed in October with January's date: "this repeats", not "invent
    // nine months of it".
    await monthly("2026-01-10", "2026-10-02T18:00:00Z", "Domain");

    await automation.generateRecurringExpenses(db, new Date("2026-10-20T18:00:00Z"));
    expect(await datesOf("Domain")).toEqual(["2026-01-10"]);

    await automation.generateRecurringExpenses(db, new Date("2026-11-12T18:00:00Z"));
    expect(await datesOf("Domain")).toEqual(["2026-01-10", "2026-11-10"]);
  });

  it("fills in at most a year after a long gap", async () => {
    await monthly("2024-01-05", "2024-01-05T18:00:00Z", "Hosting");

    await automation.generateRecurringExpenses(db, new Date("2026-10-06T18:00:00Z"));

    const dates = await datesOf("Hosting");
    expect(dates).toHaveLength(1 + 12);
    expect(dates[1]).toBe("2025-11-05");
    expect(dates.at(-1)).toBe("2026-10-05");
  });

  it("counts as an expense, not a fee", async () => {
    await monthly("2026-08-15", "2026-08-15T18:00:00Z");
    await automation.generateRecurringExpenses(db, new Date("2026-09-20T18:00:00Z"));

    const summary = await finance.ledgerSummary(admin, db, "2026-09");
    expect(summary.month).toMatchObject({ expensesCents: 1500, feesCents: 0, profitCents: -1500 });
    expect(summary.year.expensesCents).toBe(3000);
  });
});

describe("scheduling", () => {
  it("runs, then waits out the interval", async () => {
    const first = await automation.runScheduledLedger(db);
    const second = await automation.runScheduledLedger(db);

    expect(first.ran).toBe(true);
    expect(second).toEqual({ ran: false, reason: "too_soon" });
  });
});

describe("months", () => {
  it("adds months across a year end", () => {
    expect(automation.addMonths("2026-12", 1)).toBe("2027-01");
    expect(automation.addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("repeats the 31st on the last day of a short month", () => {
    expect(automation.repeatDate("2027-02", 31)).toBe("2027-02-28");
    expect(automation.repeatDate("2028-02", 31)).toBe("2028-02-29");
    expect(automation.repeatDate("2026-11", 15)).toBe("2026-11-15");
  });
});

describe("the accountant's CSV", () => {
  it("quotes text so a comma or quote cannot shift a column", () => {
    expect(csvText('Smith, "Jr"')).toBe('"Smith, ""Jr"""');
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    expect(csvText("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvText("+1")).toBe("\"'+1\"");
    expect(csvText("@SUM(A1)")).toBe("\"'@SUM(A1)\"");
  });

  it("lists oldest first with signed amounts, so the column sums to profit", () => {
    const csv = ledgerCsv([
      {
        kind: "expense",
        key: "e:2",
        publicId: "E2",
        date: "2026-10-06",
        category: "fees",
        description: "Stripe fee: Scott Mortensen Fine Arts",
        note: null,
        amountCents: 33,
        currency: "USD",
        isRecurring: false,
        automatic: true,
      },
      {
        kind: "income",
        key: "p:1",
        date: "2026-10-06",
        clientPublicId: "C1",
        counterparty: "Scott Mortensen Fine Arts",
        method: "stripe",
        reference: "in_1",
        note: null,
        amountCents: 100,
        currency: "USD",
      },
    ]);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Income"');
    expect(lines[1]).toContain(",1.00,");
    expect(lines[2]).toContain('"Fees"');
    expect(lines[2]).toContain(",-0.33,");
  });
});
