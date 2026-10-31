import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  expenses,
  organizations,
  paymentRequests,
  payments,
  servicePlans,
  subscriptions,
  users,
} from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { confirmPaymentReceived, raisePaymentRequest } from "@/db/repositories/admin/billing";
import { paymentsOverview } from "@/db/repositories/admin/payments-overview";
import {
  markInvoiceNotPaid,
  recordManualPayment,
} from "@/db/repositories/admin/payment-outcomes";
import { ledgerSummary } from "@/db/repositories/admin/finance";
import { nextBillingDate } from "@/lib/billing/billing-day";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The payments page's two lists, and the two things the operator does from
 * them: say a client paid, or say they did not.
 *
 * The old page split "Waiting on you" from "Overdue" and nobody could tell
 * how a client was billed. What has to hold now:
 *
 *  - one row per client, saying how they pay (card on file, invoiced by
 *    hand, free) and when the next payment is
 *  - every unpaid invoice past its due date is on the overdue list, and a
 *    client who said they paid is on it too, marked, and never lost
 *  - "Mark paid" records what actually arrived, by whatever means
 *  - "Not paid" either keeps chasing, cancels a charge raised by mistake, or
 *    writes it off, and says which
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let carePlanId: string;
let compPlanId: string;

// Fixed so day counts do not depend on when the suite runs. Noon UTC is
// morning in Denver: the same calendar day in both.
const NOW = new Date("2026-10-20T18:00:00Z");

async function seedClient(
  name: string,
  opts: {
    price?: number;
    provider?: "stripe" | null;
    providerStatus?: string;
    periodEnd?: Date;
    comp?: boolean;
    internal?: boolean;
    archived?: boolean;
    billingDay?: number;
  } = {},
) {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`, kind: "client" })
      .returning()
  )[0]!;
  const client = (
    await db
      .insert(clients)
      .values({
        publicId: newPublicId(),
        organizationId: org.id,
        compPlanId: opts.comp ? compPlanId : null,
        compNote: opts.comp ? "Family" : null,
        isInternal: opts.internal ?? false,
        archivedAt: opts.archived ? new Date() : null,
      })
      .returning()
  )[0]!;
  if (opts.price !== undefined) {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: client.id,
      planId: carePlanId,
      monthlyPriceCents: opts.price,
      billingDay: opts.billingDay ?? 1,
      startedOn: "2026-01-01",
      status: "active",
      provider: opts.provider ?? null,
      providerSubscriptionId: opts.provider ? `sub_${newPublicId()}` : null,
      providerStatus: opts.providerStatus ?? (opts.provider ? "active" : null),
      currentPeriodEnd: opts.periodEnd ?? null,
    });
  }
  return { orgId: org.id, clientId: client.id, clientPublicId: client.publicId };
}

async function invoice(orgId: string, amountCents: number, dueOn: string) {
  return raisePaymentRequest(admin, db, { organizationId: orgId, amountCents, dueOn });
}

async function saysPaid(requestPublicId: string) {
  await db
    .update(paymentRequests)
    .set({ status: "awaiting_confirmation", initiatedAt: new Date("2026-10-18T15:00:00Z") })
    .where(eq(paymentRequests.publicId, requestPublicId));
}

async function overview() {
  return paymentsOverview(admin, db, NOW);
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;

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
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(organizations);
  await db.delete(servicePlans);

  const plans = await db
    .insert(servicePlans)
    .values([
      { key: "care", name: "Care", defaultMonthlyCents: 5000, includedChangesPerMonth: 2 },
      { key: "comp-unlimited", name: "Complimentary — Unlimited", defaultMonthlyCents: 0, includedChangesPerMonth: null },
    ])
    .returning();
  carePlanId = plans.find((p) => p.key === "care")!.id;
  compPlanId = plans.find((p) => p.key === "comp-unlimited")!.id;
});

describe("nextBillingDate", () => {
  it("is this month's billing day until it has passed, then next month's", () => {
    expect(nextBillingDate(25, "2026-10-20")).toBe("2026-10-25");
    expect(nextBillingDate(20, "2026-10-20")).toBe("2026-10-20");
    expect(nextBillingDate(1, "2026-10-20")).toBe("2026-11-01");
    expect(nextBillingDate(5, "2026-12-20")).toBe("2027-01-05");
  });
});

describe("the clients list", () => {
  it("has one row per client, saying how each one pays", async () => {
    await seedClient("Card Co", {
      price: 4900,
      provider: "stripe",
      periodEnd: new Date("2026-11-03T15:00:00Z"),
    });
    const hand = await seedClient("Hand Co", { price: 2500, billingDay: 1 });
    await seedClient("Free Co", { comp: true });
    await seedClient("Planless Co");
    await seedClient("Our Own Site", { price: 0, internal: true });
    await seedClient("Gone Co", { price: 2500, archived: true });
    await invoice(hand.orgId, 2500, "2026-10-01");
    await confirmPaymentReceived(admin, db, (await db.select().from(paymentRequests))[0]!.publicId, {
      method: "venmo",
      receivedOn: "2026-10-02",
    });

    const { clients: rows, totals } = await overview();

    expect(rows.map((r) => r.organizationName)).toEqual(["Card Co", "Free Co", "Hand Co", "Planless Co"]);
    const by = Object.fromEntries(rows.map((r) => [r.organizationName, r]));

    expect(by["Card Co"]).toMatchObject({
      mode: "auto",
      planName: "Care",
      priceCents: 4900,
      next: { on: "2026-11-03", kind: "charge" },
      standing: { kind: "paid_up" },
      canBill: false,
    });
    expect(by["Hand Co"]).toMatchObject({
      mode: "invoiced",
      priceCents: 2500,
      next: { on: "2026-11-01", kind: "bill" },
      standing: { kind: "paid_up" },
      canBill: true,
    });
    expect(by["Free Co"]).toMatchObject({
      mode: "comp",
      planName: "Complimentary — Unlimited",
      next: null,
      standing: { kind: "comp" },
      canBill: false,
    });
    expect(by["Planless Co"]).toMatchObject({ mode: "none", standing: { kind: "no_plan" } });

    // What paying clients are expected to bring in each month. Free and
    // internal clients are not money anybody will pay.
    expect(totals).toMatchObject({ monthlyPlanCents: 7400, autoCount: 1, invoicedCount: 1, compCount: 1 });
  });

  it("says when an invoiced client has never been billed", async () => {
    await seedClient("New Co", { price: 2500, billingDay: 25 });
    const [row] = (await overview()).clients;
    expect(row).toMatchObject({ standing: { kind: "not_billed" }, next: { on: "2026-10-25", kind: "bill" }, canBill: true });
  });

  it("shows an open invoice's due date as the next payment", async () => {
    const c = await seedClient("Due Co", { price: 2500 });
    await invoice(c.orgId, 2500, "2026-10-31");

    const [row] = (await overview()).clients;
    expect(row).toMatchObject({
      standing: { kind: "due", days: 11 },
      next: { on: "2026-10-31", kind: "due" },
      canBill: false,
    });
    expect((await overview()).overdue).toHaveLength(0);
  });

  it("flags a card Stripe could not charge", async () => {
    await seedClient("Declined Co", { price: 4900, provider: "stripe", providerStatus: "past_due" });

    const result = await overview();
    expect(result.clients[0]!.standing).toEqual({ kind: "card_failing", providerStatus: "past_due" });
    expect(result.overdue).toEqual([
      expect.objectContaining({ kind: "card", organizationName: "Declined Co", amountCents: 4900 }),
    ]);
  });
});

describe("the overdue list", () => {
  it("lists every unpaid invoice past its due date, with how much and how late", async () => {
    const a = await seedClient("Late Co", { price: 2500 });
    const b = await seedClient("Later Co", { price: 4000 });
    await invoice(a.orgId, 2500, "2026-10-10");
    await invoice(b.orgId, 4000, "2026-09-20");

    const result = await overview();

    expect(
      result.overdue.map((o) => o.kind === "invoice" && [o.organizationName, o.invoice.amountCents, o.invoice.daysOverdue]),
    ).toEqual([
      ["Later Co", 4000, 30],
      ["Late Co", 2500, 10],
    ]);
    expect(result.clients.find((c) => c.organizationName === "Late Co")!.standing).toEqual({
      kind: "overdue",
      days: 10,
    });
    expect(result.totals).toMatchObject({ overdueCents: 6500, overdueClients: 2 });
  });

  it("keeps a client who said they paid on the list, marked, and first", async () => {
    const a = await seedClient("Late Co", { price: 2500 });
    const b = await seedClient("Says Co", { price: 4000 });
    await invoice(a.orgId, 2500, "2026-09-10");
    const claimed = await invoice(b.orgId, 4000, "2026-10-25");
    await saysPaid(claimed.publicId);

    const result = await overview();

    expect(result.overdue[0]).toMatchObject({
      kind: "invoice",
      organizationName: "Says Co",
      invoice: { saysPaid: true, reference: claimed.reference },
    });
    expect(result.clients.find((c) => c.organizationName === "Says Co")!.standing).toEqual({ kind: "says_paid" });
    // Not counted as owed: they say it is on its way.
    expect(result.totals).toMatchObject({ overdueCents: 2500, overdueClients: 1, saysPaidCount: 1 });
  });

  it("leaves out internal and archived clients", async () => {
    const internal = await seedClient("Our Own Site", { internal: true });
    await invoice(internal.orgId, 100, "2026-09-01");

    expect((await overview()).overdue).toHaveLength(0);
  });
});

describe("Mark paid", () => {
  it("records what actually arrived, and settles the invoice", async () => {
    const c = await seedClient("Late Co", { price: 2500 });
    const req = await invoice(c.orgId, 2500, "2026-10-01");

    const result = await confirmPaymentReceived(admin, db, req.publicId, {
      method: "venmo",
      receivedOn: "2026-10-19",
      amountCents: 2000,
      note: "Venmo @late-co, said the rest is coming",
    });
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(payments);
    expect(row).toMatchObject({ amountCents: 2000, method: "venmo", receivedOn: "2026-10-19" });
    expect(row!.note).toMatch(/rest is coming/);
    expect((await ledgerSummary(admin, db, "2026-10")).month.incomeCents).toBe(2000);
    expect((await overview()).overdue).toHaveLength(0);
  });
});

describe("Not paid", () => {
  it("puts a client who said they paid back on the chase list", async () => {
    const c = await seedClient("Says Co", { price: 2500 });
    const req = await invoice(c.orgId, 2500, "2026-10-05");
    await saysPaid(req.publicId);

    const result = await markInvoiceNotPaid(admin, db, req.publicId, { outcome: "still_owed", note: "Nothing on Venmo" });

    expect(result).toEqual({ ok: true, status: "open" });
    const [item] = (await overview()).overdue;
    expect(item).toMatchObject({ kind: "invoice", invoice: { saysPaid: false, daysOverdue: 15 } });
  });

  it("keeps an overdue invoice overdue and remembers that you checked", async () => {
    const c = await seedClient("Late Co", { price: 2500 });
    const req = await invoice(c.orgId, 2500, "2026-10-05");

    await markInvoiceNotPaid(admin, db, req.publicId, { outcome: "still_owed", note: "" });

    const [item] = (await overview()).overdue;
    expect(item?.kind === "invoice" && item.invoice.lastCheckedAt).toBeInstanceOf(Date);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "payment_request.checked"), eq(auditLog.entityId, req.publicId)));
    expect(audit).toHaveLength(1);
  });

  it("cancels a charge raised by mistake, so nobody is owed anything", async () => {
    const c = await seedClient("Oops Co", { price: 2500 });
    const req = await invoice(c.orgId, 2500, "2026-10-05");

    expect(await markInvoiceNotPaid(admin, db, req.publicId, { outcome: "cancel", note: "Billed twice" })).toEqual({
      ok: true,
      status: "cancelled",
    });

    const result = await overview();
    expect(result.overdue).toHaveLength(0);
    expect(result.clients[0]!.standing).toEqual({ kind: "paid_up" });
  });

  it("writes off a debt you have given up on", async () => {
    const c = await seedClient("Gone Quiet Co", { price: 2500 });
    const req = await invoice(c.orgId, 2500, "2026-08-05");

    expect(await markInvoiceNotPaid(admin, db, req.publicId, { outcome: "write_off", note: "" })).toEqual({
      ok: true,
      status: "written_off",
    });
    expect((await overview()).overdue).toHaveLength(0);
  });

  it("refuses an invoice that is already settled", async () => {
    const c = await seedClient("Paid Co", { price: 2500 });
    const req = await invoice(c.orgId, 2500, "2026-10-05");
    await confirmPaymentReceived(admin, db, req.publicId, { method: "cash", receivedOn: "2026-10-06" });

    expect(await markInvoiceNotPaid(admin, db, req.publicId, { outcome: "cancel", note: "" })).toEqual({
      ok: false,
      reason: "not_unpaid",
    });
    expect(await markInvoiceNotPaid(admin, db, "nope", { outcome: "cancel", note: "" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("Record payment", () => {
  it("adds money that came in outside Stripe to the ledger, and leaves the build owed", async () => {
    const c = await seedClient("Cash Co", { price: 2500 });

    const result = await recordManualPayment(admin, db, {
      clientPublicId: c.clientPublicId,
      amountCents: 2500,
      method: "venmo",
      receivedOn: "2026-10-12",
      note: "October",
      idempotencyKey: "manual:form-1",
    });

    expect(result).toMatchObject({ ok: true, duplicate: false });
    expect((await ledgerSummary(admin, db, "2026-10")).month.incomeCents).toBe(2500);
    // Money is not the build unless the operator says it is (decision D1).
    const [client] = await db.select().from(clients).where(eq(clients.id, c.clientId));
    expect(client!.buildPaidAt).toBeNull();
    expect(client!.changeRequestsUnlockedAt).toBeNull();
  });

  it("marks the build paid and unlocks the client when the operator records it as the build fee", async () => {
    const c = await seedClient("Check Co", { price: 2500 });

    const result = await recordManualPayment(admin, db, {
      clientPublicId: c.clientPublicId,
      amountCents: 50000,
      method: "check",
      receivedOn: "2026-10-12",
      note: "",
      idempotencyKey: "manual:form-build",
      coversBuild: true,
    });

    expect(result).toMatchObject({ ok: true, duplicate: false });
    const [client] = await db.select().from(clients).where(eq(clients.id, c.clientId));
    expect(client!.buildPaidAt).toBeInstanceOf(Date);
    expect(client!.analyticsUnlockedAt).toBeInstanceOf(Date);
    const [row] = await db.select().from(payments).where(eq(payments.clientId, c.clientId));
    expect(row!.note).toBe("Website build");
    const marked = await db.select().from(auditLog).where(eq(auditLog.action, "build.paid"));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.metadata).toMatchObject({ source: "manual_payment", amountCents: 50000 });
  });

  it("records a double-submitted form once", async () => {
    const c = await seedClient("Cash Co", { price: 2500 });
    const input = {
      clientPublicId: c.clientPublicId,
      amountCents: 2500,
      method: "cash" as const,
      receivedOn: "2026-10-12",
      note: "",
      idempotencyKey: "manual:form-2",
    };

    await recordManualPayment(admin, db, input);
    const second = await recordManualPayment(admin, db, input);

    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("refuses an unknown or internal client", async () => {
    const internal = await seedClient("Our Own Site", { internal: true });
    const base = { amountCents: 100, method: "cash" as const, receivedOn: "2026-10-12", note: "", idempotencyKey: "manual:x" };

    expect(await recordManualPayment(admin, db, { ...base, clientPublicId: "nope" })).toEqual({ ok: false, reason: "not_found" });
    expect(await recordManualPayment(admin, db, { ...base, clientPublicId: internal.clientPublicId })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
