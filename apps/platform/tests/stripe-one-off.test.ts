import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
  auditLog,
  changeAllowances,
  clients,
  organizations,
  paymentRequests,
  payments,
  servicePlans,
  subscriptions,
  users,
  webhookDeliveries,
} from "@/db/schema";
import {
  adminContextFrom,
  tenantContextFrom,
  type AdminContext,
  type TenantContext,
} from "@/db/repositories/context";
import { raisePaymentRequest } from "@/db/repositories/admin/billing";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * One-off card payments through Stripe Checkout: an invoice an operator
 * raised, a client's first payment, or one extra change.
 *
 * The failures worth testing are the ones that cost somebody money or trust:
 *
 *  - a client paying an amount the browser chose rather than the invoice
 *  - a client paying, or settling, another client's invoice
 *  - a double click producing two live checkouts for one invoice
 *  - a completed checkout whose money has not cleared being recorded as paid
 *  - the same payment being recorded twice because two events describe it
 *  - an extra change being paid for and never credited
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;

interface FakeSession {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: "open" | "complete" | "expired";
  mode: "payment" | "subscription";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number;
  currency: string;
  customer: string;
  metadata: Record<string, string>;
  payment_intent: unknown;
  subscription: null;
  livemode: boolean;
}

const fake = {
  sessions: new Map<string, FakeSession>(),
  created: [] as Array<{
    params: Stripe.Checkout.SessionCreateParams;
    options: Stripe.RequestOptions | undefined;
  }>,
  customersCreated: 0,
  counter: 0,
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>(
    "@/lib/payments/stripe",
  );

  return {
    ...actual,
    // Only the network edge is faked; mode matching and the rest are real.
    requireStripe: () =>
      ({
        customers: {
          create: async () => {
            fake.customersCreated += 1;
            return { id: `cus_fake_${fake.customersCreated}` };
          },
          retrieve: async () => ({ deleted: true }),
        },
        checkout: {
          sessions: {
            create: async (
              params: Stripe.Checkout.SessionCreateParams,
              options?: Stripe.RequestOptions,
            ) => {
              fake.created.push({ params, options });
              fake.counter += 1;
              const line = params.line_items?.[0];
              const session: FakeSession = {
                id: `cs_test_${fake.counter}`,
                object: "checkout.session",
                url: `https://checkout.stripe.test/${fake.counter}`,
                status: "open",
                mode: params.mode as "payment",
                payment_status: "unpaid",
                amount_total: line?.price_data?.unit_amount ?? 0,
                currency: line?.price_data?.currency ?? "usd",
                customer: String(params.customer),
                metadata: (params.metadata ?? {}) as Record<string, string>,
                payment_intent: null,
                subscription: null,
                livemode: false,
              };
              fake.sessions.set(session.id, session);
              return session;
            },
            retrieve: async (id: string) => {
              const found = fake.sessions.get(id);
              if (!found) throw new Error(`no such session ${id}`);
              return found;
            },
          },
        },
        subscriptions: {
          retrieve: async (id: string) => {
            throw new Error(`no such subscription ${id}`);
          },
          list: async () => ({ data: [] }),
        },
      }) as never,
  };
});

const { beginStripePayment } = await import(
  "@/db/repositories/client/stripe-payment"
);
const { processStripeEvent } = await import(
  "@/db/repositories/admin/stripe-webhooks"
);
const { getStripeBillingPanel } = await import(
  "@/db/repositories/client/stripe-billing"
);

interface Tenant {
  orgId: string;
  clientId: string;
  ctx: TenantContext;
}

const acme = {} as Tenant;
const globex = {} as Tenant;

async function seedTenant(name: string): Promise<Tenant> {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: name, kind: "client" })
      .returning()
  )[0]!;

  const user = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: `${name}@example.test`,
        role: "client",
        status: "active",
      })
      .returning()
  )[0]!;

  const client = (
    await db
      .insert(clients)
      .values({
        publicId: newPublicId(),
        organizationId: org.id,
        primaryContactEmail: `${name}@example.test`,
      })
      .returning()
  )[0]!;

  return {
    orgId: org.id,
    clientId: client.id,
    ctx: tenantContextFrom(
      {
        userId: user.id,
        organizationId: org.id,
        role: "client",
        status: "active",
        sessionEpoch: 0,
      },
      org.id,
    ),
  };
}

async function raiseInvoice(tenant: Tenant, amountCents = 9900) {
  return raisePaymentRequest(admin, db, {
    organizationId: tenant.orgId,
    amountCents,
    dueOn: "2026-10-15",
    note: "October care plan",
  });
}

const URLS = {
  successUrl: "https://portal.test/dashboard/billing?payment=complete",
  cancelUrl: "https://portal.test/dashboard/billing",
};

function event(
  type: string,
  object: unknown,
  id = `evt_${Math.random().toString(36).slice(2)}`,
): Stripe.Event {
  return {
    id,
    object: "event",
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  } as Stripe.Event;
}

/** Stripe's side of a client finishing checkout and the card clearing. */
function completeSession(sessionId: string, paid = true): FakeSession {
  const session = fake.sessions.get(sessionId)!;
  session.status = "complete";
  session.payment_status = paid ? "paid" : "unpaid";
  session.payment_intent = {
    id: `pi_for_${sessionId}`,
    latest_charge: {
      id: `ch_for_${sessionId}`,
      receipt_url: `https://pay.stripe.test/receipts/${sessionId}`,
    },
  };
  return session;
}

async function requestRow(publicId: string) {
  const rows = await db
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.publicId, publicId))
    .limit(1);
  return rows[0]!;
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";

  await db.delete(auditLog);
  await db.delete(webhookDeliveries);
  await db.delete(changeAllowances);
  await db.delete(paymentRequests);
  await db.delete(payments);
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);

  fake.sessions.clear();
  fake.created.length = 0;
  fake.customersCreated = 0;
  fake.counter = 0;

  // The webhook attributes an automatic confirmation to the first admin.
  const adminUser = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: "admin@example.test",
        role: "admin",
        status: "active",
      })
      .returning()
  )[0]!;
  admin = adminContextFrom({
    userId: adminUser.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });

  Object.assign(acme, await seedTenant("acme"));
  Object.assign(globex, await seedTenant("globex"));
});

describe("starting a one-off card payment", () => {
  it("charges the amount on the invoice, in payment mode, tagged with the invoice", async () => {
    const invoice = await raiseInvoice(acme, 9900);

    const outcome = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(outcome.ok).toBe(true);
    expect(fake.created).toHaveLength(1);

    const { params } = fake.created[0]!;
    expect(params.mode).toBe("payment");
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(9900);
    expect(params.metadata?.payment_request_id).toBe(invoice.publicId);
    expect(params.metadata?.client_id).toBe(acme.clientId);
    expect(params.customer).toBe("cus_fake_1");

    const row = await requestRow(invoice.publicId);
    expect(row.provider).toBe("stripe");
    expect(row.providerReference).toBe("cs_test_1");
    expect(row.checkoutUrl).toBe("https://checkout.stripe.test/1");
    // Starting a checkout is not paying.
    expect(row.status).toBe("open");
  });

  it("will not start a payment for another client's invoice", async () => {
    const invoice = await raiseInvoice(acme);

    const outcome = await beginStripePayment(db, globex.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.created).toHaveLength(0);
  });

  it("refuses an invoice that is no longer payable", async () => {
    const invoice = await raiseInvoice(acme);
    await db
      .update(paymentRequests)
      .set({ status: "cancelled" })
      .where(eq(paymentRequests.publicId, invoice.publicId));

    const outcome = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "not_payable" });
    expect(fake.created).toHaveLength(0);
  });

  it("sends a second click to the same checkout instead of opening another", async () => {
    const invoice = await raiseInvoice(acme);

    const first = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });
    const second = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(fake.created).toHaveLength(1);
    expect(first.ok && second.ok && first.url === second.url).toBe(true);
  });

  it("opens a fresh checkout once the previous one has expired", async () => {
    const invoice = await raiseInvoice(acme);

    await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });
    fake.sessions.get("cs_test_1")!.status = "expired";

    const again = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(again).toMatchObject({ ok: true, url: "https://checkout.stripe.test/2" });
    // A different idempotency key, or Stripe would hand back the expired one.
    expect(fake.created[1]!.options?.idempotencyKey).not.toBe(
      fake.created[0]!.options?.idempotencyKey,
    );
    expect((await requestRow(invoice.publicId)).providerReference).toBe("cs_test_2");
  });

  it("does not let a client pay again while a completed checkout is settling", async () => {
    const invoice = await raiseInvoice(acme);

    await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });
    completeSession("cs_test_1");

    const again = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(again).toMatchObject({ ok: false, reason: "processing" });
    expect(fake.created).toHaveLength(1);
  });

  it("is read-only while an operator is viewing as the client", async () => {
    const invoice = await raiseInvoice(acme);
    const impersonating = { ...acme.ctx, impersonating: true } as TenantContext;

    await expect(
      beginStripePayment(db, impersonating, {
        requestPublicId: invoice.publicId,
        ...URLS,
      }),
    ).rejects.toThrow(/read-only/);
    expect(fake.created).toHaveLength(0);
  });

  it("is off when Stripe has no key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const invoice = await raiseInvoice(acme);

    const outcome = await beginStripePayment(db, acme.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "not_configured" });
  });
});

describe("settling a one-off payment from the webhook", () => {
  async function startAndComplete(tenant: Tenant, paid = true) {
    const invoice = await raiseInvoice(tenant);
    await beginStripePayment(db, tenant.ctx, {
      requestPublicId: invoice.publicId,
      ...URLS,
    });
    const session = completeSession("cs_test_1", paid);
    return { invoice, session };
  }

  it("marks the invoice paid and records the payment once the card clears", async () => {
    const { invoice, session } = await startAndComplete(acme);

    const outcome = await processStripeEvent(
      db,
      event("checkout.session.completed", session),
    );
    expect(outcome.status).toBe("processed");

    const row = await requestRow(invoice.publicId);
    expect(row.status).toBe("paid");

    const ledger = await db.select().from(payments);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      clientId: acme.clientId,
      amountCents: 9900,
      method: "stripe",
      provider: "stripe",
      providerReference: `pi_for_${session.id}`,
      receiptUrl: `https://pay.stripe.test/receipts/${session.id}`,
    });
  });

  it("waits for the money when checkout completes before the payment clears", async () => {
    const { invoice, session } = await startAndComplete(acme, false);

    await processStripeEvent(db, event("checkout.session.completed", session));
    expect((await requestRow(invoice.publicId)).status).toBe("open");
    expect(await db.select().from(payments)).toHaveLength(0);

    session.payment_status = "paid";
    await processStripeEvent(
      db,
      event("checkout.session.async_payment_succeeded", session),
    );
    expect((await requestRow(invoice.publicId)).status).toBe("paid");
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("records one payment when two events describe the same checkout", async () => {
    const { session } = await startAndComplete(acme);

    await processStripeEvent(db, event("checkout.session.completed", session));
    await processStripeEvent(
      db,
      event("checkout.session.async_payment_succeeded", session),
    );

    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("reads the payment status from Stripe, not from the event", async () => {
    // An old "completed, unpaid" event replayed after the money cleared must
    // not hold the invoice open, and a forged-looking "paid" in a stale
    // payload is not what decides.
    const { invoice, session } = await startAndComplete(acme, true);
    const stale = { ...session, payment_status: "unpaid" };

    await processStripeEvent(db, event("checkout.session.completed", stale));

    expect((await requestRow(invoice.publicId)).status).toBe("paid");
  });

  it("will not settle one client's invoice from another client's checkout", async () => {
    const acmeInvoice = await raiseInvoice(acme);
    const { session } = await startAndComplete(globex);
    // Globex's checkout, pointing at Acme's invoice.
    session.metadata = { ...session.metadata, payment_request_id: acmeInvoice.publicId };

    const outcome = await processStripeEvent(
      db,
      event("checkout.session.completed", session, "evt_cross"),
    );

    expect(outcome.status).toBe("unmatched");
    expect((await requestRow(acmeInvoice.publicId)).status).toBe("open");
    expect(await db.select().from(payments)).toHaveLength(0);

    const delivery = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, "evt_cross"));
    expect(delivery[0]?.status).toBe("needs_review");
  });

  it("credits the extra change that was paid for", async () => {
    const period = { start: "2026-10-01", end: "2026-10-31" };
    await db.insert(changeAllowances).values({
      clientId: acme.clientId,
      periodStart: period.start,
      periodEnd: period.end,
      included: 1,
      used: 1,
    });
    const request = (
      await db
        .insert(paymentRequests)
        .values({
          publicId: newPublicId(),
          clientId: acme.clientId,
          reference: "MW-EXTRA1",
          amountCents: 2500,
          status: "open",
          purpose: "extra_change",
          coversPeriodStart: period.start,
          coversPeriodEnd: period.end,
          note: "One additional change this month",
        })
        .returning()
    )[0]!;

    await beginStripePayment(db, acme.ctx, {
      requestPublicId: request.publicId,
      ...URLS,
    });
    const session = completeSession("cs_test_1");
    await processStripeEvent(db, event("checkout.session.completed", session));

    const allowance = await db
      .select({ included: changeAllowances.included })
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));
    expect(allowance[0]?.included).toBe(2);
  });

  it("keeps one-off payments out of the automatic-payments history", async () => {
    const { session } = await startAndComplete(acme);
    await processStripeEvent(db, event("checkout.session.completed", session));

    const panel = await getStripeBillingPanel(db, acme.ctx);

    expect(panel.history).toHaveLength(0);
    expect(panel.status.state).toBe("not_subscribed");
  });
});

describe("plans stay where they were", () => {
  it("does not touch a client's plan when they pay a one-off invoice", async () => {
    const plan = await db
      .select({ id: servicePlans.id })
      .from(servicePlans)
      .where(eq(servicePlans.key, "care-lite"))
      .limit(1);
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      planId: plan[0]!.id,
      monthlyPriceCents: 5000,
      startedOn: "2026-09-01",
      status: "active",
    });

    const { session } = await (async () => {
      const invoice = await raiseInvoice(acme, 5000);
      await beginStripePayment(db, acme.ctx, {
        requestPublicId: invoice.publicId,
        ...URLS,
      });
      return { session: completeSession("cs_test_1") };
    })();
    await processStripeEvent(db, event("checkout.session.completed", session));

    const subs = await db
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.clientId, acme.clientId));
    expect(subs).toEqual([{ status: "active" }]);
  });
});
