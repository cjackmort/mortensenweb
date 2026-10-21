import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { clientAddOns, clients, payments, subscriptions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";
import { addCoupon, addSubscription, fakeStripe, resetFakeStripe } from "./helpers/fake-stripe";

/**
 * The receiver's half of the cart: one checkout, recorded as a build payment
 * and a subscription.
 *
 * The failures worth testing are the ones that misstate money: the build
 * counted as subscription revenue (or twice, once each way), a redelivered
 * event recording either part again, a build-only promo mirrored as a
 * discount on the plan, and a checkout whose money has not cleared marking
 * the website paid.
 */

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  const { fakeStripe: fake } = await import("./helpers/fake-stripe");
  return { ...actual, requireStripe: () => fake.client as never };
});

const { processStripeEvent } = await import("@/db/repositories/admin/stripe-webhooks");

const BUILD_PRODUCT = "prod_website_build";
const PERIOD_END = 1_800_000_000;

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let eventCounter = 0;

function event(type: string, object: unknown): Stripe.Event {
  eventCounter += 1;
  return { id: `evt_cart_${eventCounter}`, type, livemode: false, data: { object } } as unknown as Stripe.Event;
}

function cartMetadata(): Record<string, string> {
  return { checkout: "cart", client_id: acme.clientId, build_key: "website", build_product: BUILD_PRODUCT, plan_key: "care" };
}

function line(input: {
  id: string;
  amount: number;
  discount?: number;
  product: string;
  kind: "invoice_item_details" | "subscription_item_details";
}) {
  return {
    id: input.id,
    amount: input.amount,
    discount_amounts: input.discount ? [{ amount: input.discount, discount: "di_1" }] : [],
    parent: { type: input.kind },
    pricing: { type: "price_details", price_details: { price: `price_${input.id}`, product: input.product } },
    period: { start: 1_797_000_000, end: PERIOD_END },
  };
}

/** The first invoice of a cart subscription: build $500 less $100, Care $50, Review requests $35. */
function firstInvoice(subscriptionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `in_${subscriptionId}`,
    object: "invoice",
    customer: "cus_acme",
    billing_reason: "subscription_create",
    amount_paid: 48500,
    total: 48500,
    currency: "usd",
    status: "paid",
    status_transitions: { paid_at: 1_797_000_000 },
    hosted_invoice_url: "https://invoice.stripe.test/in_first",
    metadata: {},
    parent: { subscription_details: { subscription: subscriptionId, metadata: cartMetadata() } },
    lines: {
      data: [
        line({ id: "li_build", amount: 50000, discount: 10000, product: BUILD_PRODUCT, kind: "invoice_item_details" }),
        line({ id: "li_care", amount: 5000, product: "prod_care", kind: "subscription_item_details" }),
        line({ id: "li_reviews", amount: 3500, product: "prod_reviews", kind: "subscription_item_details" }),
      ],
    },
    ...overrides,
  };
}

function cartSubscription() {
  return addSubscription({
    customer: "cus_acme",
    metadata: cartMetadata(),
    items: [
      { lookupKey: "care_monthly_v2", unitAmount: 5000, product: "prod_care", periodEnd: PERIOD_END },
      { lookupKey: "addon_reviews_monthly_v1", unitAmount: 3500, product: "prod_reviews", periodEnd: PERIOD_END },
    ],
  });
}

async function ledger() {
  return db
    .select({ key: payments.idempotencyKey, cents: payments.amountCents, subscriptionId: payments.subscriptionId, note: payments.note })
    .from(payments)
    .where(eq(payments.clientId, acme.clientId));
}

async function clientRow() {
  const [row] = await db
    .select({ buildPaidAt: clients.buildPaidAt, analyticsUnlockedAt: clients.analyticsUnlockedAt })
    .from(clients)
    .where(eq(clients.id, acme.clientId));
  return row!;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  resetFakeStripe();
  acme = await seedTenant(db, `Acme ${newPublicId()}`);
  await db.update(clients).set({ stripeCustomerId: `cus_${newPublicId()}` }).where(eq(clients.id, acme.clientId));
});

describe("a cart paid with a plan: one invoice, two ledger rows", () => {
  it("records the build and the first month separately, and the mirror and add-ons", async () => {
    const sub = cartSubscription();

    const outcome = await processStripeEvent(db, event("invoice.paid", firstInvoice(sub.id)));

    expect(outcome.status).toBe("processed");
    const rows = await ledger();
    const [mirror] = await db.select().from(subscriptions).where(eq(subscriptions.clientId, acme.clientId));
    expect(rows).toEqual(
      expect.arrayContaining([
        { key: `stripe_invoice:in_${sub.id}:build`, cents: 40000, subscriptionId: null, note: "Website build" },
        { key: `stripe_invoice:in_${sub.id}`, cents: 8500, subscriptionId: mirror!.id, note: null },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(mirror).toMatchObject({ provider: "stripe", providerSubscriptionId: sub.id, monthlyPriceCents: 5000 });
    const addOns = await db.select().from(clientAddOns).where(eq(clientAddOns.clientId, acme.clientId));
    expect(addOns.map((a) => a.featureKey)).toEqual(["reviews"]);
    const client = await clientRow();
    expect(client.buildPaidAt).not.toBeNull();
    expect(client.analyticsUnlockedAt).not.toBeNull();
  });

  it("records each part once however many events describe the invoice", async () => {
    const sub = cartSubscription();
    const invoice = firstInvoice(sub.id);

    await processStripeEvent(db, event("invoice.paid", invoice));
    await processStripeEvent(db, event("invoice.paid", invoice));

    expect(await ledger()).toHaveLength(2);
  });

  it("links on checkout completion without recording money, and records it when the invoice settles", async () => {
    const sub = cartSubscription();
    const session = {
      id: "cs_cart_sub",
      object: "checkout.session",
      mode: "subscription",
      customer: "cus_acme",
      subscription: sub.id,
      payment_status: "paid",
      metadata: cartMetadata(),
    };

    await processStripeEvent(db, event("checkout.session.completed", session));
    expect(await ledger()).toEqual([]);
    expect((await clientRow()).buildPaidAt).toBeNull();
    expect(await db.select().from(subscriptions).where(eq(subscriptions.clientId, acme.clientId))).toHaveLength(1);

    await processStripeEvent(db, event("invoice.paid", firstInvoice(sub.id)));
    expect(await ledger()).toHaveLength(2);
  });

  it("does not split a later monthly invoice", async () => {
    const sub = cartSubscription();
    const renewal = firstInvoice(sub.id, {
      id: `in_renewal_${sub.id}`,
      billing_reason: "subscription_cycle",
      amount_paid: 8500,
      total: 8500,
      lines: {
        data: [
          line({ id: "li_care", amount: 5000, product: "prod_care", kind: "subscription_item_details" }),
          line({ id: "li_reviews", amount: 3500, product: "prod_reviews", kind: "subscription_item_details" }),
        ],
      },
    });

    await processStripeEvent(db, event("invoice.paid", renewal));

    expect((await ledger()).map((r) => [r.key, r.cents])).toEqual([[`stripe_invoice:in_renewal_${sub.id}`, 8500]]);
  });

  it("does not mirror a build-only promo as a discount on the plan", async () => {
    const sub = cartSubscription();
    addCoupon({ id: "co_web100", amount_off: 10000, applies_to: { products: [BUILD_PRODUCT] } });
    sub.discounts = [
      { id: "di_1", object: "discount", end: null, promotion_code: null, source: { type: "coupon", coupon: "co_web100" } },
    ];

    await processStripeEvent(db, event("customer.subscription.created", sub));

    const [mirror] = await db.select().from(subscriptions).where(eq(subscriptions.clientId, acme.clientId));
    expect(mirror).toMatchObject({ monthlyPriceCents: 5000, discountedPriceCents: null, discountLabel: null });
  });
});

describe("a cart paid for the build alone", () => {
  function paidSession(overrides: Partial<Record<string, unknown>> = {}) {
    const session = {
      id: `cs_cart_${newPublicId()}`,
      object: "checkout.session",
      mode: "payment",
      customer: "cus_acme",
      subscription: null,
      payment_status: "paid",
      amount_total: 40000,
      currency: "usd",
      metadata: { ...cartMetadata(), plan_key: "" },
      payment_intent: { id: "pi_build", latest_charge: { receipt_url: "https://pay.stripe.test/receipt" } },
      ...overrides,
    };
    fakeStripe.state.sessions.set(session.id, session);
    return session;
  }

  it("records the build payment, marks the website paid and unlocks the portal", async () => {
    const session = paidSession();

    const outcome = await processStripeEvent(db, event("checkout.session.completed", session));

    expect(outcome.status).toBe("processed");
    expect(await ledger()).toEqual([
      { key: `stripe_checkout:${session.id}:build`, cents: 40000, subscriptionId: null, note: "Website build" },
    ]);
    const client = await clientRow();
    expect(client.buildPaidAt).not.toBeNull();
    expect(client.analyticsUnlockedAt).not.toBeNull();
  });

  it("records it once when the bank-transfer event follows the completed one", async () => {
    const session = paidSession();

    await processStripeEvent(db, event("checkout.session.completed", session));
    await processStripeEvent(db, event("checkout.session.async_payment_succeeded", session));

    expect(await ledger()).toHaveLength(1);
  });

  it("records nothing while the money has not cleared", async () => {
    const session = paidSession({ payment_status: "unpaid" });

    await processStripeEvent(db, event("checkout.session.completed", session));

    expect(await ledger()).toEqual([]);
    expect((await clientRow()).buildPaidAt).toBeNull();
  });

  it("re-reads the session rather than trusting the event", async () => {
    const session = paidSession({ payment_status: "unpaid" });

    await processStripeEvent(db, event("checkout.session.completed", { ...session, payment_status: "paid" }));

    expect(await ledger()).toEqual([]);
  });
});
