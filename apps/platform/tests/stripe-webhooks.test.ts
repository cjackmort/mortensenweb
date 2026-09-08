import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
  clients,
  organizations,
  payments,
  servicePlans,
  subscriptions,
  webhookDeliveries,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * The Stripe receiver, against a real database.
 *
 * Everything here is a way money or access goes wrong:
 *
 *  - the same event delivered twice paying a client twice
 *  - an older event arriving late and resurrecting a cancelled subscription
 *  - a payment event overwriting an operator's complimentary grant
 *  - a database failure being acknowledged as success, losing the payment
 *  - an event for a customer nobody owns being attached to whoever is handy
 *  - a live event processed by a test deployment
 */

let db: Database;
let close: () => Promise<void>;

/** The fake Stripe API the processor re-fetches from. */
const stripeState = {
  subscriptions: new Map<string, Stripe.Subscription>(),
  customers: new Map<string, Stripe.Customer>(),
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/payments/stripe")
  >("@/lib/payments/stripe");

  return {
    ...actual,
    // Only the network edge is faked. The pure helpers — mode matching,
    // status mapping, the invoice field shape — are the real ones, so these
    // tests exercise the code that ships.
    requireStripe: () =>
      ({
        subscriptions: {
          retrieve: async (id: string) => {
            const found = stripeState.subscriptions.get(id);
            if (!found) throw new Error(`no such subscription ${id}`);
            return found;
          },
        },
        customers: {
          retrieve: async (id: string) =>
            stripeState.customers.get(id) ?? { deleted: true },
        },
      }) as never,
  };
});

const { processStripeEvent } = await import(
  "@/db/repositories/admin/stripe-webhooks"
);


let clientId: string;


const CUSTOMER = "cus_test_1";
const SUBSCRIPTION = "sub_test_1";

function subscriptionObject(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: SUBSCRIPTION,
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    cancel_at_period_end: false,
    start_date: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
    metadata: { client_id: clientId },
    items: {
      object: "list",
      data: [
        {
          id: "si_1",
          object: "subscription_item",
          current_period_end: Math.floor(
            Date.parse("2026-10-01T00:00:00Z") / 1000,
          ),
          price: {
            id: "price_1",
            object: "price",
            lookup_key: "care_basic_monthly_v1",
            unit_amount: 10000,
            currency: "usd",
          },
        } as never,
      ],
      has_more: false,
      url: "",
    },
    ...overrides,
  } as Stripe.Subscription;
}

function invoiceObject(
  overrides: Record<string, unknown> = {},
): Stripe.Invoice {
  return {
    id: "in_test_1",
    object: "invoice",
    customer: CUSTOMER,
    currency: "usd",
    amount_paid: 10000,
    total: 10000,
    amount_due: 10000,
    hosted_invoice_url: "https://invoice.stripe.com/test",
    status_transitions: {
      paid_at: Math.floor(Date.parse("2026-09-08T00:00:00Z") / 1000),
    },
    parent: { subscription_details: { subscription: SUBSCRIPTION } },
    lines: {
      data: [
        {
          period: {
            start: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
            end: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000),
          },
        },
      ],
    },
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Invoice;
}

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

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  // Fresh tenant per test so nothing leaks between them.
  await db.delete(payments);
  await db.delete(webhookDeliveries);
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(organizations);

  const plan = await db
    .select({ id: servicePlans.id })
    .from(servicePlans)
    .where(eq(servicePlans.key, "care-basic"))
    .limit(1);
  expect(plan[0]).toBeTruthy();

  const org = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Test Co",
        slug: `test-${Math.random().toString(36).slice(2, 8)}`,
        kind: "client",
      })
      .returning()
  )[0]!;


  const client = (
    await db
      .insert(clients)
      .values({
        publicId: newPublicId(),
        organizationId: org.id,
        stripeCustomerId: CUSTOMER,
      })
      .returning()
  )[0]!;
  clientId = client.id;

  stripeState.subscriptions.clear();
  stripeState.customers.clear();
  stripeState.subscriptions.set(SUBSCRIPTION, subscriptionObject());
});

describe("idempotency", () => {
  it("processes an invoice once and records one ledger row", async () => {
    const first = await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject(), "evt_dup"),
    );
    expect(first.status).toBe("processed");

    const rows = await db.select().from(payments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(10000);
  });

  it("recognises a redelivery of the same event", async () => {
    await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject(), "evt_dup"),
    );
    const second = await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject(), "evt_dup"),
    );

    expect(second.status).toBe("duplicate");
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  it("does not double-charge when two different events describe one invoice", async () => {
    // The belt to the delivery table's braces: distinct event ids, same
    // invoice. Without the payments idempotency key this is a second charge in
    // the ledger and a month of revenue counted twice.
    await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject(), "evt_a"),
    );
    await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject(), "evt_b"),
    );

    expect(await db.select().from(payments)).toHaveLength(1);
  });
});

describe("out-of-order delivery", () => {
  it("does not let a stale event resurrect a cancelled subscription", async () => {
    // Stripe currently says cancelled. An older "active" event arrives late.
    stripeState.subscriptions.set(
      SUBSCRIPTION,
      subscriptionObject({ status: "canceled" }),
    );

    await processStripeEvent(
      db,
      event(
        "customer.subscription.updated",
        subscriptionObject({ status: "active" }),
      ),
    );

    const rows = await db.select().from(subscriptions);
    // State came from the re-fetch, not from the stale payload.
    expect(rows[0]!.providerStatus).toBe("canceled");
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("keeps a scheduled cancellation distinct from a cancelled account", async () => {
    stripeState.subscriptions.set(
      SUBSCRIPTION,
      subscriptionObject({ status: "active", cancel_at_period_end: true }),
    );

    await processStripeEvent(
      db,
      event("customer.subscription.updated", subscriptionObject()),
    );

    const rows = await db.select().from(subscriptions);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.cancelAtPeriodEnd).toBe(true);
  });
});

describe("complimentary clients", () => {
  beforeEach(async () => {
    const comp = await db
      .select({ id: servicePlans.id })
      .from(servicePlans)
      .where(eq(servicePlans.key, "comp-unlimited"))
      .limit(1);

    await db
      .update(clients)
      .set({ compPlanId: comp[0]!.id, compNote: "Founder's cousin" })
      .where(eq(clients.id, clientId));
  });

  it("does not let a subscription event overwrite a comp grant", async () => {
    const outcome = await processStripeEvent(
      db,
      event("customer.subscription.updated", subscriptionObject()),
    );

    expect(outcome.status).toBe("processed");
    // No subscription row was written for them at all.
    expect(await db.select().from(subscriptions)).toHaveLength(0);

    const row = await db
      .select({ compPlanId: clients.compPlanId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    expect(row[0]!.compPlanId).not.toBeNull();
  });

  it("still records the ledger row but leaves entitlements alone", async () => {
    await processStripeEvent(db, event("invoice.paid", invoiceObject()));

    // The money is recorded — it genuinely arrived — but nothing about their
    // comp status changed.
    expect(await db.select().from(payments)).toHaveLength(1);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });
});

describe("settlement is not cash", () => {
  it("records a zero-collection invoice as zero", async () => {
    await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject({ amount_paid: 0, total: 10000 })),
    );

    const rows = await db.select().from(payments);
    expect(rows[0]!.amountCents).toBe(0);
    expect(rows[0]!.note).toMatch(/without collecting cash/i);
  });

  it("does not unlock features on an invoice that collected nothing", async () => {
    await processStripeEvent(
      db,
      event("invoice.paid", invoiceObject({ amount_paid: 0 })),
    );

    const row = await db
      .select({ unlocked: clients.changeRequestsUnlockedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);

    expect(row[0]!.unlocked).toBeNull();
  });

  it("unlocks on an invoice that did collect", async () => {
    await processStripeEvent(db, event("invoice.paid", invoiceObject()));

    const row = await db
      .select({ unlocked: clients.changeRequestsUnlockedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);

    expect(row[0]!.unlocked).not.toBeNull();
  });
});

describe("unmatched events", () => {
  it("records rather than guessing when no client owns the customer", async () => {
    const outcome = await processStripeEvent(
      db,
      event(
        "invoice.paid",
        invoiceObject({ customer: "cus_stranger", metadata: {} }),
      ),
    );

    expect(outcome.status).toBe("unmatched");
    // Nothing was attached to whoever happened to be handy.
    expect(await db.select().from(payments)).toHaveLength(0);

    const delivery = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries);
    expect(delivery[0]!.status).toBe("unmatched");
  });
});

describe("mode isolation", () => {
  it("refuses a live event on a test key", async () => {
    const live = {
      ...event("invoice.paid", invoiceObject()),
      livemode: true,
    } as Stripe.Event;

    const outcome = await processStripeEvent(db, live);

    expect(outcome.status).toBe("ignored");
    expect(await db.select().from(payments)).toHaveLength(0);
  });
});

describe("failure stays retryable", () => {
  it("leaves a failed delivery re-runnable rather than acknowledging it", async () => {
    // The subscription is missing from Stripe, so the re-fetch throws.
    stripeState.subscriptions.clear();

    await expect(
      processStripeEvent(
        db,
        event("customer.subscription.updated", subscriptionObject(), "evt_fail"),
      ),
    ).rejects.toThrow();

    const delivery = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, "evt_fail"))
      .limit(1);
    expect(delivery[0]!.status).toBe("failed");

    // Stripe retries. This time it works, and the retry is NOT swallowed as a
    // duplicate — which is what would turn a blip into a lost payment.
    stripeState.subscriptions.set(SUBSCRIPTION, subscriptionObject());

    const retry = await processStripeEvent(
      db,
      event("customer.subscription.updated", subscriptionObject(), "evt_fail"),
    );
    expect(retry.status).toBe("processed");
    expect(await db.select().from(subscriptions)).toHaveLength(1);
  });
});

describe("failed payments", () => {
  it("does not pause management or take anything offline", async () => {
    stripeState.subscriptions.set(
      SUBSCRIPTION,
      subscriptionObject({ status: "past_due" }),
    );

    await processStripeEvent(
      db,
      event("invoice.payment_failed", invoiceObject({ amount_paid: 0 })),
    );

    const row = await db
      .select({
        state: clients.managementState,
        pausedAt: clients.managementPausedAt,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);

    expect(row[0]!.state).toBe("managed");
    expect(row[0]!.pausedAt).toBeNull();
  });

  it("keeps the client on the books as active", async () => {
    stripeState.subscriptions.set(
      SUBSCRIPTION,
      subscriptionObject({ status: "past_due" }),
    );

    await processStripeEvent(
      db,
      event("invoice.payment_failed", invoiceObject({ amount_paid: 0 })),
    );

    const rows = await db.select().from(subscriptions);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.providerStatus).toBe("past_due");
  });
});

describe("checkout completion", () => {
  it("links the subscription without recording a payment", async () => {
    // Visiting the success URL, and even completing checkout, is not proof of
    // payment. Only a settled invoice is.
    const outcome = await processStripeEvent(
      db,
      event("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        mode: "subscription",
        customer: CUSTOMER,
        subscription: SUBSCRIPTION,
        metadata: { client_id: clientId },
      }),
    );

    expect(outcome.status).toBe("processed");
    expect(await db.select().from(subscriptions)).toHaveLength(1);
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it("matches by customer metadata when the local link is missing", async () => {
    // The real race: the event beats the write-back that stores the customer
    // id. Without this route a client's first payment lands unmatched.
    await db
      .update(clients)
      .set({ stripeCustomerId: null })
      .where(eq(clients.id, clientId));

    stripeState.customers.set(CUSTOMER, {
      id: CUSTOMER,
      object: "customer",
      metadata: { client_id: clientId },
    } as never);

    const outcome = await processStripeEvent(
      db,
      event("checkout.session.completed", {
        id: "cs_2",
        object: "checkout.session",
        mode: "subscription",
        customer: CUSTOMER,
        subscription: SUBSCRIPTION,
        metadata: {},
      }),
    );

    expect(outcome.status).toBe("processed");

    // And it healed the missing link for next time.
    const row = await db
      .select({ customerId: clients.stripeCustomerId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    expect(row[0]!.customerId).toBe(CUSTOMER);
  });
});

describe("refunds and disputes", () => {
  it("records for review rather than clawing back access", async () => {
    await processStripeEvent(db, event("invoice.paid", invoiceObject()));

    const outcome = await processStripeEvent(
      db,
      event("charge.refunded", {
        id: "ch_1",
        object: "charge",
        customer: CUSTOMER,
        amount: 10000,
        amount_refunded: 10000,
      }),
    );

    expect(outcome.status).toBe("processed");

    // The ledger row is untouched — payments are never deleted — and the
    // client keeps access until an operator decides otherwise.
    expect(await db.select().from(payments)).toHaveLength(1);

    const row = await db
      .select({ unlocked: clients.changeRequestsUnlockedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    expect(row[0]!.unlocked).not.toBeNull();

    const delivery = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event, "charge.refunded"))
      .limit(1);
    expect(delivery[0]!.status).toBe("needs_review");
  });
});
