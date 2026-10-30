import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
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
 * Deleting from the ledger.
 *
 * The operator needs a ledger row gone: a payment marked against the wrong
 * client, a test entry, a receipt typed twice. What must hold when it goes:
 *
 *  - it leaves every total, not just the table
 *  - who deleted it, when and why is kept
 *  - nothing the platform runs on a schedule brings it back: not the Stripe
 *    resync, not the fee job, not the monthly-repeat job
 *  - a client's features are never locked again because a row went
 *  - an invoice the payment settled is unpaid again, and marking it paid a
 *    second time counts the money once
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let adminUserId: string;
let orgId: string;
let clientId: string;

const stripeState = { balanceTransactions: new Map<string, unknown>() };

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>(
    "@/lib/payments/stripe",
  );
  const intent = (id: string) => ({
    id,
    latest_charge: { id: `ch_${id}`, balance_transaction: stripeState.balanceTransactions.get(id) ?? null },
  });
  return {
    ...actual,
    requireStripe: () =>
      ({
        invoices: {
          retrieve: async (id: string) => ({
            id,
            payments: { data: [{ status: "paid", payment: { payment_intent: `pi_of_${id}` } }] },
          }),
        },
        paymentIntents: { retrieve: async (id: string) => intent(id) },
        charges: { retrieve: async () => ({ balance_transaction: null }) },
      }) as never,
  };
});

const { confirmPaymentReceived, raisePaymentRequest } = await import(
  "@/db/repositories/admin/billing"
);
const finance = await import("@/db/repositories/admin/finance");
const deletes = await import("@/db/repositories/admin/ledger-deletes");
const automation = await import("@/db/repositories/admin/ledger-automation");
const { applyPaidInvoice } = await import("@/db/repositories/admin/stripe-webhooks");

const today = () => businessDate(new Date());
const thisMonth = () => today().slice(0, 7);

async function paidInvoice(amountCents = 5000, receivedOn = today()) {
  const request = await raisePaymentRequest(admin, db, {
    organizationId: orgId,
    amountCents,
    dueOn: receivedOn,
  });
  const confirmed = await confirmPaymentReceived(admin, db, request.publicId, {
    method: "venmo",
    receivedOn,
  });
  if (!confirmed.ok) throw new Error("confirm failed");
  return { request, paymentPublicId: confirmed.paymentPublicId };
}

async function monthTotals() {
  return (await finance.ledgerSummary(admin, db, thisMonth())).month;
}

async function entries() {
  return finance.ledgerEntries(admin, db, finance.monthRange(thisMonth()));
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
  adminUserId = adminUser.id;
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

  const org = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Wasatch Tile",
        slug: `wasatch-${Math.random().toString(36).slice(2, 8)}`,
        kind: "client",
      })
      .returning()
  )[0]!;
  orgId = org.id;
  clientId = (
    await db.insert(clients).values({ publicId: newPublicId(), organizationId: org.id }).returning()
  )[0]!.id;
});

describe("deleting a payment", () => {
  it("takes it out of the ledger and every total", async () => {
    const { paymentPublicId } = await paidInvoice(5000);
    expect((await monthTotals()).incomeCents).toBe(5000);

    const result = await deletes.voidPayment(admin, db, paymentPublicId, { reason: "Wrong client" });

    expect(result).toMatchObject({ ok: true, alreadyVoid: false });
    expect(await entries()).toHaveLength(0);
    expect(await monthTotals()).toMatchObject({ incomeCents: 0, profitCents: 0 });
    expect((await finance.ledgerSummary(admin, db, thisMonth())).year.incomeCents).toBe(0);
    expect(await finance.sumPaymentsReceivedInMonth(admin, db)).toBe(0);
  });

  it("keeps the row, with who deleted it, when and why, and an audit entry", async () => {
    const { paymentPublicId } = await paidInvoice();

    await deletes.voidPayment(admin, db, paymentPublicId, { reason: "Typed twice" });

    const [row] = await db.select().from(payments).where(eq(payments.publicId, paymentPublicId));
    expect(row).toMatchObject({ status: "void", voidedBy: adminUserId, voidReason: "Typed twice" });
    expect(row!.voidedAt).toBeInstanceOf(Date);

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "payment.voided"), eq(auditLog.entityId, paymentPublicId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ amountCents: 5000, reason: "Typed twice" });

    const deleted = await deletes.listDeletedLedgerRows(admin, db, finance.monthRange(thisMonth()));
    expect(deleted).toEqual([
      expect.objectContaining({ kind: "income", publicId: paymentPublicId, amountCents: 5000, reason: "Typed twice" }),
    ]);
  });

  it("does nothing the second time", async () => {
    const { paymentPublicId } = await paidInvoice();

    await deletes.voidPayment(admin, db, paymentPublicId, {});
    const again = await deletes.voidPayment(admin, db, paymentPublicId, {});

    expect(again).toMatchObject({ ok: true, alreadyVoid: true });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "payment.voided"))).toHaveLength(1);
  });

  it("reports a payment that does not exist", async () => {
    expect(await deletes.voidPayment(admin, db, "nope", {})).toEqual({ ok: false, reason: "not_found" });
  });

  it("never locks the client's features again", async () => {
    const { paymentPublicId } = await paidInvoice();
    const before = (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!;
    expect(before.analyticsUnlockedAt).toBeInstanceOf(Date);

    await deletes.voidPayment(admin, db, paymentPublicId, {});

    const after = (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!;
    expect(after.analyticsUnlockedAt).toEqual(before.analyticsUnlockedAt);
    expect(after.changeRequestsUnlockedAt).toEqual(before.changeRequestsUnlockedAt);
  });

  it("makes the invoice it paid unpaid again, and a second Mark paid counts once", async () => {
    const { request, paymentPublicId } = await paidInvoice(5000);

    const result = await deletes.voidPayment(admin, db, paymentPublicId, {});
    expect(result).toMatchObject({ ok: true, reopenedInvoice: request.reference });

    const [reopened] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.publicId, request.publicId));
    expect(reopened).toMatchObject({ status: "open", paymentId: null, confirmedAt: null });

    const again = await confirmPaymentReceived(admin, db, request.publicId, {
      method: "cash",
      receivedOn: today(),
    });
    expect(again).toMatchObject({ ok: true, alreadyConfirmed: false });
    expect(again.ok && again.paymentPublicId).not.toBe(paymentPublicId);

    expect((await monthTotals()).incomeCents).toBe(5000);
    expect((await entries()).filter((e) => e.kind === "income")).toHaveLength(1);
  });

  it("puts an invoice the client said they paid back to waiting on you, not to overdue", async () => {
    const request = await raisePaymentRequest(admin, db, {
      organizationId: orgId,
      amountCents: 2500,
      dueOn: today(),
    });
    await db
      .update(paymentRequests)
      .set({ status: "awaiting_confirmation", initiatedAt: new Date() })
      .where(eq(paymentRequests.publicId, request.publicId));
    const confirmed = await confirmPaymentReceived(admin, db, request.publicId, {
      method: "venmo",
      receivedOn: today(),
    });

    await deletes.voidPayment(admin, db, confirmed.ok ? confirmed.paymentPublicId : "", {});

    const [row] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.publicId, request.publicId));
    expect(row!.status).toBe("awaiting_confirmation");
  });

  it("stays deleted when Stripe reports the same invoice again", async () => {
    const [stripeRow] = await db
      .insert(payments)
      .values({
        publicId: newPublicId(),
        clientId,
        amountCents: 4900,
        method: "stripe",
        provider: "stripe",
        providerReference: "in_123",
        idempotencyKey: "stripe_invoice:in_123",
        receivedOn: today(),
      })
      .returning();

    await deletes.voidPayment(admin, db, stripeRow!.publicId, { reason: "Refunded" });

    // What the hourly resync and a redelivered `invoice.paid` both call.
    const outcome = await applyPaidInvoice(
      db,
      { clientId, organizationId: orgId },
      { id: "in_123", amount_paid: 4900, currency: "usd", lines: { data: [] } } as unknown as Stripe.Invoice,
      "stripe_reconcile",
    );

    expect(outcome).toBe("already");
    expect(await db.select().from(payments)).toHaveLength(1);
    expect((await monthTotals()).incomeCents).toBe(0);
  });

  it("stops the fee job looking for the deleted payment's fee", async () => {
    const [stripeRow] = await db
      .insert(payments)
      .values({
        publicId: newPublicId(),
        clientId,
        amountCents: 4900,
        method: "stripe",
        provider: "stripe",
        providerReference: "in_456",
        idempotencyKey: "stripe_invoice:in_456",
        receivedOn: today(),
      })
      .returning();
    stripeState.balanceTransactions.set("pi_of_in_456", {
      id: "txn_1",
      fee: 172,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
    });

    await deletes.voidPayment(admin, db, stripeRow!.publicId, {});
    await automation.recordStripeFees(db);

    expect(await db.select().from(expenses)).toHaveLength(0);
  });
});

describe("deleting an expense", () => {
  async function expense(description: string, amountCents: number) {
    return (await finance.addExpense(admin, db, {
      description,
      category: "software",
      amountCents,
      occurredOn: today(),
      isRecurring: false,
    }))!;
  }

  it("takes it out of the ledger and every total, keeping who and when", async () => {
    const row = await expense("Figma", 1500);
    expect((await monthTotals()).expensesCents).toBe(1500);

    expect(await deletes.deleteExpense(admin, db, row.publicId)).toBe("deleted");

    expect(await entries()).toHaveLength(0);
    expect((await monthTotals()).expensesCents).toBe(0);

    const [kept] = await db.select().from(expenses).where(eq(expenses.publicId, row.publicId));
    expect(kept!.deletedBy).toBe(adminUserId);
    expect(kept!.deletedAt).toBeInstanceOf(Date);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "expense.deleted"))).toHaveLength(1);

    expect(await deletes.deleteExpense(admin, db, row.publicId)).toBe("already");
    expect(await deletes.deleteExpense(admin, db, "nope")).toBe("not_found");
  });

  it("does not bring back a deleted Stripe fee", async () => {
    const [stripeRow] = await db
      .insert(payments)
      .values({
        publicId: newPublicId(),
        clientId,
        amountCents: 4900,
        method: "stripe",
        provider: "stripe",
        providerReference: "in_789",
        idempotencyKey: "stripe_invoice:in_789",
        receivedOn: today(),
      })
      .returning();
    stripeState.balanceTransactions.set("pi_of_in_789", {
      id: "txn_2",
      fee: 172,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
    });
    await automation.recordStripeFees(db);
    const feeId = await automation.feeRowId(stripeRow!.id);

    await deletes.deleteExpense(admin, db, feeId);
    await automation.recordStripeFees(db);

    expect((await monthTotals()).feesCents).toBe(0);
  });

  it("does not bring back a deleted month of a monthly expense", async () => {
    const template = (await finance.addExpense(admin, db, {
      description: "Netlify",
      category: "hosting",
      amountCents: 1900,
      occurredOn: "2026-07-15",
      isRecurring: true,
    }))!;
    await db
      .update(expenses)
      .set({ createdAt: new Date("2026-07-15T18:00:00Z") })
      .where(eq(expenses.id, template.id));
    const now = new Date("2026-09-20T18:00:00Z");
    await automation.generateRecurringExpenses(db, now);

    const august = (await finance.ledgerEntries(admin, db, finance.monthRange("2026-08")))[0]!;
    expect(august.kind).toBe("expense");
    await deletes.deleteExpense(admin, db, august.kind === "expense" ? august.publicId : "");
    await automation.generateRecurringExpenses(db, now);

    expect(await finance.ledgerEntries(admin, db, finance.monthRange("2026-08"))).toHaveLength(0);
    expect(await finance.ledgerEntries(admin, db, finance.monthRange("2026-09"))).toHaveLength(1);
  });

  it("stops the series when the repeating row itself is deleted", async () => {
    const template = (await finance.addExpense(admin, db, {
      description: "Canva",
      category: "software",
      amountCents: 1200,
      occurredOn: "2026-07-10",
      isRecurring: true,
    }))!;
    await db
      .update(expenses)
      .set({ createdAt: new Date("2026-07-10T18:00:00Z") })
      .where(eq(expenses.id, template.id));

    await deletes.deleteExpense(admin, db, template.publicId);
    await automation.generateRecurringExpenses(db, new Date("2026-09-20T18:00:00Z"));

    expect((await finance.ledgerSummary(admin, db, "2026-09")).year.expensesCents).toBe(0);
  });
});

describe("deleting several rows at once", () => {
  it("deletes income and expenses together and reports what it did", async () => {
    const { request, paymentPublicId } = await paidInvoice(5000);
    const figma = (await finance.addExpense(admin, db, {
      description: "Figma",
      category: "software",
      amountCents: 1500,
      occurredOn: today(),
      isRecurring: false,
    }))!;
    const kept = (await finance.addExpense(admin, db, {
      description: "Netlify",
      category: "hosting",
      amountCents: 1900,
      occurredOn: today(),
      isRecurring: false,
    }))!;

    const result = await deletes.deleteLedgerRows(
      admin,
      db,
      [
        { kind: "income", publicId: paymentPublicId },
        { kind: "expense", publicId: figma.publicId },
        { kind: "expense", publicId: "gone-already" },
      ],
      "Clearing out test entries",
    );

    expect(result).toEqual({
      deletedIncome: 1,
      deletedExpenses: 1,
      reopenedInvoices: [request.reference],
      notFound: 1,
    });
    expect(await monthTotals()).toMatchObject({ incomeCents: 0, expensesCents: 1900 });
    expect((await entries()).map((e) => e.kind === "expense" && e.publicId)).toEqual([kept.publicId]);
  });
});
