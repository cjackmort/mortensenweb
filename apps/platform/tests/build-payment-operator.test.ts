import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, organizations, paymentRequests, payments, sites, users } from "@/db/schema";
import type { AdminContext } from "@/db/repositories/context";
import { buildInvoicePublicId } from "@/db/repositories/build-standing";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The build from the operator's side (roadmap P1.3, decision D1).
 *
 * - Marking the build's invoice paid marks the build paid; any other invoice
 *   does not.
 * - Marking paid, cancelling or writing off closes the Stripe checkout still
 *   open for that invoice, and settling the build closes every checkout that
 *   would charge for it again.
 * - A build a 100%-off code took to zero settles at zero.
 * - Connecting the domain and going live refuse until the build is settled.
 */

const CUSTOMER = "cus_operator_1";

const stripeState = {
  sessions: new Map<string, Record<string, unknown>>(),
  /** Set to make every call fail, as an outage would. */
  down: false,
};

function api<T>(fn: T): T {
  return ((...args: unknown[]) => {
    if (stripeState.down) throw new Error("Stripe is unreachable");
    return (fn as (...a: unknown[]) => unknown)(...args);
  }) as T;
}

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        checkout: {
          sessions: {
            list: api(async (params: { status?: string; customer?: string }) => ({
              data: [...stripeState.sessions.values()].filter(
                (s) => (!params.status || s.status === params.status) && (!params.customer || s.customer === params.customer),
              ),
            })),
            retrieve: api(async (id: string) => {
              const found = stripeState.sessions.get(id);
              if (!found) throw new Error(`no such session ${id}`);
              return found;
            }),
            expire: api(async (id: string) => {
              const found = stripeState.sessions.get(id)!;
              found.status = "expired";
              return found;
            }),
          },
        },
      }) as never,
  };
});

const { confirmPaymentReceived, raisePaymentRequest } = await import("@/db/repositories/admin/billing");
const { markInvoiceNotPaid } = await import("@/db/repositories/admin/payment-outcomes");
const { settleOneOffCheckout } = await import("@/db/repositories/admin/stripe-one-off");
const { sendDnsInstructions, verifyAndGoLive } = await import("@/db/repositories/admin/launch");

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let clientId: string;
let organizationId: string;

function session(id: string, values: Record<string, unknown>) {
  stripeState.sessions.set(id, { id, object: "checkout.session", status: "open", customer: CUSTOMER, metadata: {}, ...values });
}

const statusOf = (id: string) => stripeState.sessions.get(id)!.status;

async function client() {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId));
  return row!;
}

async function invoice(values: Partial<typeof paymentRequests.$inferInsert> = {}) {
  const [row] = await db
    .insert(paymentRequests)
    .values({
      publicId: newPublicId(),
      clientId,
      reference: `MW-${newPublicId().slice(0, 5)}`,
      amountCents: 50000,
      status: "open",
      ...values,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  const [user] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "op@example.test", role: "admin", status: "active" })
    .returning();
  admin = { userId: user!.id } as AdminContext;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(paymentRequests);
  await db.delete(payments);
  await db.delete(sites);
  await db.delete(clients);
  await db.delete(organizations);
  stripeState.sessions.clear();
  stripeState.down = false;

  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name: "Op Co", slug: `op-${newPublicId().slice(0, 6).toLowerCase()}`, kind: "client" })
    .returning();
  organizationId = org!.id;
  const [row] = await db
    .insert(clients)
    .values({ publicId: newPublicId(), organizationId, stripeCustomerId: CUSTOMER, primaryContactEmail: "op@co.example" })
    .returning();
  clientId = row!.id;
});

describe("Mark paid", () => {
  it("marks the build paid, and lets the client in, for the build's invoice", async () => {
    const request = await invoice({ purpose: "build" });

    const result = await confirmPaymentReceived(admin, db, request.publicId, { method: "check", receivedOn: "2026-10-30" });

    expect(result).toMatchObject({ ok: true, alreadyConfirmed: false });
    const row = await client();
    expect(row.buildPaidAt).toBeInstanceOf(Date);
    expect(row.changeRequestsUnlockedAt).toBeInstanceOf(Date);
  });

  it("counts the welcome checkout's own build invoice, raised before it had a purpose", async () => {
    const request = await invoice({ publicId: await buildInvoicePublicId(clientId), purpose: "other" });

    await confirmPaymentReceived(admin, db, request.publicId, { method: "cash", receivedOn: "2026-10-30" });

    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
  });

  it("leaves the build owed, and the client locked, for any other invoice", async () => {
    const request = await invoice({ purpose: "subscription", amountCents: 5000 });

    await confirmPaymentReceived(admin, db, request.publicId, { method: "venmo", receivedOn: "2026-10-30" });

    const row = await client();
    expect(row.buildPaidAt).toBeNull();
    expect(row.changeRequestsUnlockedAt).toBeNull();
  });

  it("closes the invoice's open checkout, so the client cannot pay it a second time", async () => {
    session("cs_invoice", { mode: "payment" });
    const request = await invoice({ purpose: "subscription", provider: "stripe", providerReference: "cs_invoice" });

    await confirmPaymentReceived(admin, db, request.publicId, { method: "cash", receivedOn: "2026-10-30" });

    expect(statusOf("cs_invoice")).toBe("expired");
  });

  it("closes every open checkout that charges for the build once the build is paid", async () => {
    const buildId = await buildInvoicePublicId(clientId);
    session("cs_build_only", { mode: "payment", metadata: { payment_request_id: buildId } });
    session("cs_welcome_with_build", {
      mode: "subscription",
      metadata: { source: "welcome", welcome_basket: "plan:care|add:none|build:50000" },
    });
    session("cs_welcome_plan_only", {
      mode: "subscription",
      metadata: { source: "welcome", welcome_basket: "plan:care|add:none|build:0" },
    });
    const request = await invoice({ publicId: buildId, purpose: "build", provider: "stripe", providerReference: "cs_build_only" });

    await confirmPaymentReceived(admin, db, request.publicId, { method: "check", receivedOn: "2026-10-30" });

    expect(statusOf("cs_build_only")).toBe("expired");
    expect(statusOf("cs_welcome_with_build")).toBe("expired");
    // Nothing in it is paid for yet: a plan on its own is still theirs to buy.
    expect(statusOf("cs_welcome_plan_only")).toBe("open");
    const [expired] = await db.select().from(auditLog).where(eq(auditLog.action, "checkout.expired"));
    expect(expired!.metadata).toMatchObject({ reason: "invoice_paid" });
  });

  it("still records the payment when Stripe cannot be reached, and says what it could not close", async () => {
    session("cs_unreachable", { mode: "payment" });
    const request = await invoice({ purpose: "build", provider: "stripe", providerReference: "cs_unreachable" });
    stripeState.down = true;

    const result = await confirmPaymentReceived(admin, db, request.publicId, { method: "cash", receivedOn: "2026-10-30" });

    expect(result).toMatchObject({ ok: true });
    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
    const [failed] = await db.select().from(auditLog).where(eq(auditLog.action, "checkout.expire_failed"));
    expect(failed!.metadata).toMatchObject({ needsOperatorReview: true, failed: expect.arrayContaining(["cs_unreachable"]) });
  });

  it("finishes marking the build when a confirmation that died part-way is retried", async () => {
    const request = await invoice({ purpose: "build" });
    await confirmPaymentReceived(admin, db, request.publicId, { method: "cash", receivedOn: "2026-10-30" });
    // As if the first run stopped between settling the invoice and the build.
    await db.update(clients).set({ buildPaidAt: null, changeRequestsUnlockedAt: null }).where(eq(clients.id, clientId));

    const retry = await confirmPaymentReceived(admin, db, request.publicId, { method: "cash", receivedOn: "2026-10-30" });

    expect(retry).toMatchObject({ ok: true, alreadyConfirmed: true });
    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
    expect((await client()).changeRequestsUnlockedAt).toBeInstanceOf(Date);
  });

  it("refuses an operator recording zero", async () => {
    const request = await invoice({ purpose: "build" });

    await expect(
      confirmPaymentReceived(admin, db, request.publicId, { method: "cash", receivedOn: "2026-10-30", amountCents: 0 }),
    ).rejects.toThrow(/positive/);
  });
});

describe("raising an invoice for the build", () => {
  it("records it as the build's, so paying it marks the build paid", async () => {
    const raised = await raisePaymentRequest(admin, db, { organizationId, amountCents: 42000, dueOn: "2026-11-15", forBuild: true });

    const [row] = await db.select().from(paymentRequests).where(eq(paymentRequests.publicId, raised.publicId));
    expect(row!.purpose).toBe("build");
  });
});

describe("cancelling or writing off", () => {
  it("closes the invoice's open checkout", async () => {
    session("cs_cancel", { mode: "payment" });
    session("cs_write_off", { mode: "payment" });
    const cancel = await invoice({ provider: "stripe", providerReference: "cs_cancel" });
    const writeOff = await invoice({ provider: "stripe", providerReference: "cs_write_off" });

    await markInvoiceNotPaid(admin, db, cancel.publicId, { outcome: "cancel", note: "" });
    await markInvoiceNotPaid(admin, db, writeOff.publicId, { outcome: "write_off", note: "" });

    expect(statusOf("cs_cancel")).toBe("expired");
    expect(statusOf("cs_write_off")).toBe("expired");
  });

  it("leaves the checkout open for an invoice that is still owed", async () => {
    session("cs_owed", { mode: "payment" });
    const owed = await invoice({ provider: "stripe", providerReference: "cs_owed" });

    await markInvoiceNotPaid(admin, db, owed.publicId, { outcome: "still_owed", note: "" });

    expect(statusOf("cs_owed")).toBe("open");
  });
});

describe("a build a 100%-off code took to zero", () => {
  it("settles the build invoice at zero and marks the build paid", async () => {
    const buildId = await buildInvoicePublicId(clientId);
    await invoice({ publicId: buildId, purpose: "build", provider: "stripe", providerReference: "cs_free" });
    session("cs_free", {
      mode: "payment",
      status: "complete",
      payment_status: "no_payment_required",
      amount_total: 0,
      total_details: { amount_discount: 50000 },
      payment_intent: null,
      metadata: { client_id: clientId, payment_request_id: buildId },
    });

    const settled = await settleOneOffCheckout(db, {
      sessionId: "cs_free",
      eventType: "checkout.session.completed",
      match: { clientId, organizationId },
    });

    expect(settled.deliveryStatus).toBe("processed");
    const [request] = await db.select().from(paymentRequests).where(eq(paymentRequests.publicId, buildId));
    expect(request!.status).toBe("paid");
    const [row] = await db.select().from(payments).where(eq(payments.clientId, clientId));
    expect(row).toMatchObject({ amountCents: 0 });
    expect(row!.note).toMatch(/without collecting cash/);
    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
    // The discount explains the difference: not a mismatch for review.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "payment.amount_mismatch"))).toEqual([]);
  });
});

describe("going live and connecting the domain (decision D1)", () => {
  async function site() {
    const [row] = await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId, name: "Op Co", netlifySiteName: "op-co" })
      .returning();
    return row!;
  }

  it("refuses both while the build is owed, before anything else is checked", async () => {
    const { publicId } = await site();

    expect(await sendDnsInstructions(admin, db, publicId)).toMatchObject({ ok: false, reason: "build_unpaid" });
    const live = await verifyAndGoLive(admin, db, publicId);
    expect(live).toMatchObject({ ok: false, reason: "build_unpaid" });
    if (!live.ok) expect(live.message).toMatch(/build isn't paid/);
  });

  it("goes on to the next check once the build is paid", async () => {
    const { publicId } = await site();
    await db.update(clients).set({ buildPaidAt: new Date() }).where(eq(clients.id, clientId));

    // No domain recorded: the gate is behind it, and nothing is fetched.
    expect(await sendDnsInstructions(admin, db, publicId)).toMatchObject({ ok: false, reason: "no_domain" });
    expect(await verifyAndGoLive(admin, db, publicId)).toMatchObject({ ok: false, reason: "no_domain" });
  });

  it("lets a build the operator recorded as free through", async () => {
    const { publicId } = await site();
    await db
      .update(clients)
      .set({ freeBuildValueCents: 50000, freeBuildOn: "2026-10-01" })
      .where(eq(clients.id, clientId));

    expect(await verifyAndGoLive(admin, db, publicId)).toMatchObject({ reason: "no_domain" });
  });
});
