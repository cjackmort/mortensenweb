import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, clients, notifications, organizations, paymentRequests, payments, users } from "@/db/schema";
import { buildInvoicePublicId } from "@/db/repositories/build-standing";
import type { EmailMessage, SendResult } from "@/lib/email/mailer";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The website build through Stripe's events (roadmap P1.3, decision D1).
 *
 * - A subscription's first invoice carrying the build is two ledger rows, and
 *   only its build line marks the build paid — a plan's invoice never does.
 * - The reconciliation job repairs a missed one-off checkout, which has no
 *   Stripe invoice and used to be invisible to it.
 * - A failed card payment emails the client once per invoice.
 *
 * Only the network edge is faked: Stripe's API and the mail provider.
 */

const CUSTOMER = "cus_build_1";
const SUBSCRIPTION = "sub_build_1";
const BUILD_PRODUCT = "prod_website_build";
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const stripeState = {
  subscriptions: new Map<string, Stripe.Subscription>(),
  paidInvoices: [] as Stripe.Invoice[],
  sessions: new Map<string, Record<string, unknown>>(),
};

const mail = {
  sent: [] as EmailMessage[],
  result: { status: "sent", id: "email_1" } as SendResult | Error,
};

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: EmailMessage): Promise<SendResult> => {
    if (mail.result instanceof Error) throw mail.result;
    if (mail.result.status === "sent") mail.sent.push(message);
    return mail.result;
  },
}));

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        subscriptions: {
          retrieve: async (id: string) => {
            const found = stripeState.subscriptions.get(id);
            if (!found) throw new Error(`no such subscription ${id}`);
            return found;
          },
          list: async () => ({ data: [...stripeState.subscriptions.values()] }),
        },
        customers: { retrieve: async () => ({ deleted: true }) },
        invoices: { list: async () => ({ data: stripeState.paidInvoices }) },
        checkout: {
          sessions: {
            list: async (params: { status?: string; customer?: string }) => ({
              data: [...stripeState.sessions.values()].filter(
                (s) => (!params.status || s.status === params.status) && (!params.customer || s.customer === params.customer),
              ),
            }),
            retrieve: async (id: string) => {
              const found = stripeState.sessions.get(id);
              if (!found) throw new Error(`no such session ${id}`);
              return found;
            },
            expire: async (id: string) => {
              const found = stripeState.sessions.get(id)!;
              found.status = "expired";
              return found;
            },
          },
        },
      }) as never,
  };
});

const { processStripeEvent } = await import("@/db/repositories/admin/stripe-webhooks");
const { reconcileStripe } = await import("@/db/repositories/admin/stripe-reconcile");

let db: Database;
let close: () => Promise<void>;
let clientId: string;
let organizationId: string;

function subscriptionObject(): Stripe.Subscription {
  return {
    id: SUBSCRIPTION,
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    cancel_at_period_end: false,
    start_date: at("2026-09-05T18:00:00Z"),
    metadata: { client_id: clientId },
    items: {
      object: "list",
      data: [
        {
          id: "si_plan",
          object: "subscription_item",
          current_period_end: at("2026-10-05T18:00:00Z"),
          price: { id: "price_care", object: "price", lookup_key: "care_monthly_v2", unit_amount: 5000, currency: "usd" },
        },
      ],
      has_more: false,
      url: "",
    },
  } as unknown as Stripe.Subscription;
}

const buildLine = (discount = 0) => ({
  amount: 50000,
  discount_amounts: discount ? [{ amount: discount, discount: "di_1" }] : [],
  parent: { type: "invoice_item_details" },
  pricing: { price_details: { price: "price_build", product: BUILD_PRODUCT } },
  period: { start: at("2026-09-04T18:00:00Z"), end: at("2026-09-04T18:00:00Z") },
});

const planLine = (discount = 0) => ({
  amount: 5000,
  discount_amounts: discount ? [{ amount: discount, discount: "di_2" }] : [],
  parent: { type: "subscription_item_details" },
  pricing: { price_details: { price: "price_care", product: "prod_care" } },
  period: { start: at("2026-09-05T18:00:00Z"), end: at("2026-10-05T18:00:00Z") },
});

/** A subscription's first invoice from the welcome checkout: the build listed first. */
function firstInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: "in_first",
    object: "invoice",
    customer: CUSTOMER,
    currency: "usd",
    billing_reason: "subscription_create",
    amount_paid: 55000,
    amount_due: 55000,
    total: 55000,
    hosted_invoice_url: "https://invoice.stripe.test/in_first",
    status_transitions: { paid_at: at("2026-09-05T18:00:00Z") },
    parent: {
      subscription_details: { subscription: SUBSCRIPTION, metadata: { client_id: clientId, build_product: BUILD_PRODUCT } },
    },
    lines: { data: [buildLine(), planLine()] },
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function planInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return firstInvoice({ id: "in_plan", amount_paid: 5000, amount_due: 5000, total: 5000, lines: { data: [planLine()] }, ...overrides });
}

function event(type: string, object: unknown, id = `evt_${newPublicId()}`): Stripe.Event {
  return { id, object: "event", type, livemode: false, created: 0, data: { object } } as Stripe.Event;
}

async function client() {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId));
  return row!;
}

async function ledger() {
  const rows = await db.select().from(payments).where(eq(payments.clientId, clientId));
  return rows.sort((a, b) => (a.idempotencyKey ?? "").localeCompare(b.idempotencyKey ?? ""));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  // `settleOneOffCheckout` records as the first admin.
  await db.insert(users).values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(notifications);
  await db.delete(paymentRequests);
  await db.delete(payments);
  await db.delete(clients);
  await db.delete(organizations);

  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name: "Build Co", slug: `build-${newPublicId().slice(0, 6).toLowerCase()}`, kind: "client" })
    .returning();
  organizationId = org!.id;
  const [row] = await db
    .insert(clients)
    .values({
      publicId: newPublicId(),
      organizationId,
      stripeCustomerId: CUSTOMER,
      primaryContactName: "Pat",
      primaryContactEmail: "pat@build.example",
    })
    .returning();
  clientId = row!.id;

  stripeState.subscriptions.clear();
  stripeState.subscriptions.set(SUBSCRIPTION, subscriptionObject());
  stripeState.paidInvoices = [];
  stripeState.sessions.clear();
  mail.sent.length = 0;
  mail.result = { status: "sent", id: "email_1" };
});

describe("the build on a subscription's first invoice", () => {
  it("records the build and the plan as two rows, the plan for its own month", async () => {
    const outcome = await processStripeEvent(db, event("invoice.paid", firstInvoice()));
    expect(outcome.status).toBe("processed");

    const [plan, build] = await ledger();
    expect(build).toMatchObject({
      idempotencyKey: "stripe_invoice:in_first:build",
      amountCents: 50000,
      subscriptionId: null,
      coversPeriodStart: null,
      note: "Website build",
    });
    // From the plan's line, not `lines.data[0]` — which here is the build,
    // bought on the 4th, and would have made the month one day long.
    expect(plan).toMatchObject({
      idempotencyKey: "stripe_invoice:in_first",
      amountCents: 5000,
      coversPeriodStart: "2026-09-05",
      coversPeriodEnd: "2026-10-05",
    });
    expect(plan!.subscriptionId).not.toBeNull();
  });

  it("marks the build paid and lets the client in", async () => {
    await processStripeEvent(db, event("invoice.paid", firstInvoice()));

    const row = await client();
    expect(row.buildPaidAt).toBeInstanceOf(Date);
    expect(row.changeRequestsUnlockedAt).toBeInstanceOf(Date);
    const marked = await db.select().from(auditLog).where(eq(auditLog.action, "build.paid"));
    expect(marked.map((m) => m.metadata)).toEqual([
      expect.objectContaining({ source: "stripe_invoice", reference: "in_first", amountCents: 50000 }),
    ]);
  });

  it("adds nothing when a second event describes the same invoice", async () => {
    await processStripeEvent(db, event("invoice.paid", firstInvoice()));
    const firstMarked = (await client()).buildPaidAt;
    await processStripeEvent(db, event("invoice.paid", firstInvoice()));

    expect(await ledger()).toHaveLength(2);
    expect((await client()).buildPaidAt).toEqual(firstMarked);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "build.paid"))).toHaveLength(1);
  });

  it("leaves the build owed, and the client locked, when only a plan is paid", async () => {
    await processStripeEvent(db, event("invoice.paid", planInvoice()));

    const rows = await ledger();
    expect(rows).toEqual([expect.objectContaining({ idempotencyKey: "stripe_invoice:in_plan", amountCents: 5000 })]);
    const row = await client();
    expect(row.buildPaidAt).toBeNull();
    expect(row.changeRequestsUnlockedAt).toBeNull();
  });

  it("counts a build a 100%-off code took to zero as paid, and records the zero", async () => {
    await processStripeEvent(
      db,
      event("invoice.paid", firstInvoice({ amount_paid: 5000, total: 5000, lines: { data: [buildLine(50000), planLine()] } })),
    );

    const [, build] = await ledger();
    expect(build).toMatchObject({ amountCents: 0, idempotencyKey: "stripe_invoice:in_first:build" });
    expect(build!.note).toMatch(/without collecting cash/);
    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
    expect((await client()).changeRequestsUnlockedAt).toBeInstanceOf(Date);
  });

  it("lets the client in when codes took the whole first invoice to zero", async () => {
    // A build code and a first-month code together: Stripe collects nothing,
    // the build is still paid, and the client is not asked for $500 again.
    await processStripeEvent(
      db,
      event("invoice.paid", firstInvoice({ amount_paid: 0, total: 0, lines: { data: [buildLine(50000), planLine(5000)] } })),
    );

    expect((await ledger()).map((r) => r.amountCents)).toEqual([0, 0]);
    expect((await client()).changeRequestsUnlockedAt).toBeInstanceOf(Date);
  });

  it("withdraws a build-only invoice opened earlier, and closes its checkout", async () => {
    // The client pressed "Put it live" alone, came back, chose a plan beside
    // the build and paid that page instead. The first must not charge again.
    const buildId = await buildInvoicePublicId(clientId);
    await db.insert(paymentRequests).values({
      publicId: buildId,
      clientId,
      reference: "MW-OPEN",
      amountCents: 50000,
      status: "open",
      purpose: "build",
      provider: "stripe",
      providerReference: "cs_build_first",
    });
    stripeState.sessions.set("cs_build_first", {
      id: "cs_build_first",
      status: "open",
      mode: "payment",
      customer: CUSTOMER,
      metadata: { payment_request_id: buildId },
    });

    await processStripeEvent(db, event("invoice.paid", firstInvoice()));

    const [request] = await db.select().from(paymentRequests).where(eq(paymentRequests.publicId, buildId));
    expect(request!.status).toBe("cancelled");
    expect(stripeState.sessions.get("cs_build_first")!.status).toBe("expired");
    expect(await ledger()).toHaveLength(2);
  });

  it("unlocks on a plan's invoice once the build was paid before it", async () => {
    await db.update(clients).set({ buildPaidAt: new Date() }).where(eq(clients.id, clientId));
    await processStripeEvent(db, event("invoice.paid", planInvoice()));

    expect((await client()).changeRequestsUnlockedAt).toBeInstanceOf(Date);
  });
});

describe("reconciliation and the split ledger", () => {
  it("records a missed first invoice as both rows and marks the build paid", async () => {
    stripeState.paidInvoices = [firstInvoice()];

    const result = await reconcileStripe(db);

    expect(result.ok).toBe(true);
    expect((await ledger()).map((r) => r.amountCents)).toEqual([5000, 50000]);
    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
  });

  it("does not report a split invoice as an amount mismatch", async () => {
    await processStripeEvent(db, event("invoice.paid", firstInvoice()));
    stripeState.paidInvoices = [firstInvoice()];

    const result = await reconcileStripe(db);

    expect(result.findings.filter((f) => f.kind === "amount_mismatch")).toEqual([]);
  });
});

describe("reconciliation and missed one-off checkouts", () => {
  async function openBuildInvoice(sessionId: string) {
    const publicId = await buildInvoicePublicId(clientId);
    await db.insert(paymentRequests).values({
      publicId,
      clientId,
      reference: `MW-${newPublicId().slice(0, 4)}`,
      amountCents: 50000,
      status: "open",
      purpose: "build",
      provider: "stripe",
      providerReference: sessionId,
    });
    return publicId;
  }

  function paidSession(id: string, requestPublicId: string) {
    stripeState.sessions.set(id, {
      id,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      customer: CUSTOMER,
      amount_total: 50000,
      currency: "usd",
      total_details: { amount_discount: 0 },
      metadata: { client_id: clientId, payment_request_id: requestPublicId },
      payment_intent: { id: "pi_build", latest_charge: { receipt_url: "https://pay.stripe.test/receipt" } },
    });
  }

  it("settles a paid build checkout whose webhook never arrived", async () => {
    const requestPublicId = await openBuildInvoice("cs_build_missed");
    paidSession("cs_build_missed", requestPublicId);

    const result = await reconcileStripe(db);

    expect(result).toMatchObject({ ok: true, checkedCheckouts: 1 });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ kind: "missing_payment", repaired: true, reference: "cs_build_missed" }),
    );
    const [request] = await db.select().from(paymentRequests).where(eq(paymentRequests.publicId, requestPublicId));
    expect(request!.status).toBe("paid");
    expect(await ledger()).toEqual([expect.objectContaining({ amountCents: 50000, idempotencyKey: `payment_request:${requestPublicId}` })]);
    expect((await client()).buildPaidAt).toBeInstanceOf(Date);
  });

  it("leaves a checkout alone once its invoice is paid", async () => {
    const requestPublicId = await openBuildInvoice("cs_build_done");
    paidSession("cs_build_done", requestPublicId);
    await reconcileStripe(db);

    const again = await reconcileStripe(db);

    expect(again.findings.filter((f) => f.reference === "cs_build_done")).toEqual([]);
    expect(await ledger()).toHaveLength(1);
  });
});

describe("telling the client a card payment failed", () => {
  const failed = (overrides: Record<string, unknown> = {}) =>
    planInvoice({ id: "in_failed", number: "MW-0042", amount_paid: 0, amount_due: 5000, ...overrides });

  it("emails them once per invoice, with Stripe's page to pay it, however many retries fail", async () => {
    await processStripeEvent(db, event("invoice.payment_failed", failed({ attempt_count: 1 })));
    await processStripeEvent(db, event("invoice.payment_failed", failed({ attempt_count: 2 })));

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("pat@build.example");
    expect(mail.sent[0]!.subject).toBe("Your $50.00 card payment didn't go through");
    expect(mail.sent[0]!.text).toContain("https://invoice.stripe.test/in_first");
    expect(mail.sent[0]!.text).not.toMatch(/offline|taken down/);
    const [note] = await db.select().from(notifications).where(eq(notifications.dedupeKey, "payment_failed:in_failed"));
    expect(note).toMatchObject({ status: "sent", kind: "payment_failed" });
  });

  it("does not email a client an operator exempted from reminders", async () => {
    await db
      .update(clients)
      .set({ dunningExemptUntil: new Date(Date.now() + 86_400_000) })
      .where(eq(clients.id, clientId));

    await processStripeEvent(db, event("invoice.payment_failed", failed()));

    expect(mail.sent).toEqual([]);
    const [note] = await db.select().from(notifications).where(eq(notifications.kind, "payment_failed"));
    expect(note!.status).toBe("suppressed");
  });

  it("never records an email as sent when the mailer only logged it", async () => {
    mail.result = { status: "skipped", reason: "no_api_key" };
    await processStripeEvent(db, event("invoice.payment_failed", failed()));
    expect(await db.select().from(notifications)).toEqual([]);

    // The first attempt with a real key sends it.
    mail.result = { status: "sent", id: "email_2" };
    await processStripeEvent(db, event("invoice.payment_failed", failed()));
    expect(mail.sent).toHaveLength(1);
  });

  it("still processes the delivery when the mail provider throws", async () => {
    mail.result = new Error("resend is down");

    const outcome = await processStripeEvent(db, event("invoice.payment_failed", failed()));

    expect(outcome.status).toBe("processed");
    const recorded = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "payment.failed"), eq(auditLog.entityId, "in_failed")));
    expect(recorded).toHaveLength(1);
  });
});
