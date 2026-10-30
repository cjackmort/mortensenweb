import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { BUILD, GROWTH_FEATURES, PLANS } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { auditLog, clients, paymentRequests, payments, servicePlans } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The welcome checkout against a real database and a fake Stripe.
 *
 * What matters is what reaches Stripe: the lines, the mode, and who it is
 * for — and that nothing reaches it for a client who owes nothing, cannot
 * choose, or already pays. Only the network edge is faked.
 */

interface FakeSession {
  id: string;
  object: "checkout.session";
  url: string;
  status: "open" | "complete" | "expired";
  mode: "payment" | "subscription";
  customer: string;
  metadata: Record<string, string>;
  expires_at: number;
  /** As `expand: ["data.line_items"]` returns it, so Billing's reuse check sees the prices. */
  line_items: { data: Array<{ price: { id: string } | null }> };
}

const fake = {
  configured: true,
  liveSubscription: false,
  sessions: new Map<string, FakeSession>(),
  created: [] as Array<{ params: Stripe.Checkout.SessionCreateParams; options?: Stripe.RequestOptions }>,
  counter: 0,
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    stripeConfigured: () => fake.configured,
    priceForPlan: async (key: string) => ({ id: `price_plan_${key}` }),
    priceForAddOn: async (key: string) => ({ id: `price_addon_${key}` }),
    requireStripe: () =>
      ({
        customers: { create: async () => ({ id: `cus_${newPublicId()}` }) },
        subscriptions: {
          list: async () => ({ data: fake.liveSubscription ? [{ id: "sub_live", status: "active" }] : [] }),
        },
        checkout: {
          sessions: {
            create: async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
              fake.created.push({ params, options });
              fake.counter += 1;
              const session: FakeSession = {
                id: `cs_test_${fake.counter}`,
                object: "checkout.session",
                url: `https://checkout.stripe.test/${fake.counter}`,
                status: "open",
                mode: params.mode as FakeSession["mode"],
                customer: String(params.customer),
                metadata: (params.metadata ?? {}) as Record<string, string>,
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                line_items: {
                  data: (params.line_items ?? []).map((item) => ({ price: item.price ? { id: item.price } : null })),
                },
              };
              fake.sessions.set(session.id, session);
              return session;
            },
            list: async (params: { customer: string; status: string }) => ({
              data: [...fake.sessions.values()].filter(
                (s) => s.customer === params.customer && s.status === params.status,
              ),
            }),
            retrieve: async (id: string) => {
              const found = fake.sessions.get(id);
              if (!found) throw new Error(`no such session ${id}`);
              return found;
            },
          },
        },
      }) as never,
  };
});

const { beginWelcomeCheckout, getWelcomeOffer, siteDueFor, buildInvoicePublicId } = await import(
  "@/db/repositories/client/onboarding-checkout"
);
const { beginStripeCheckout } = await import("@/db/repositories/client/stripe-checkout");

let db: Database;
let close: () => Promise<void>;

const URLS = {
  successUrl: "https://portal.test/dashboard/get-started?paid=1",
  cancelUrl: "https://portal.test/dashboard/welcome",
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  fake.configured = true;
  fake.liveSubscription = false;
  fake.sessions.clear();
  fake.created.length = 0;
});

async function freshClient(name = "Acme"): Promise<SeededTenant> {
  return seedTenant(db, name);
}

async function recordPayment(tenant: SeededTenant, amountCents = 50_000) {
  await db.insert(payments).values({
    publicId: newPublicId(),
    clientId: tenant.clientId,
    amountCents,
    method: "cash",
    receivedOn: "2026-10-01",
  });
}

async function compPlanId(): Promise<string> {
  const [row] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, "comp-unlimited"));
  if (row) return row.id;
  const [made] = await db
    .insert(servicePlans)
    .values({ key: "comp-unlimited", name: "Complimentary", defaultMonthlyCents: 0 })
    .returning({ id: servicePlans.id });
  return made!.id;
}

async function raiseInvoice(tenant: SeededTenant, values: Partial<typeof paymentRequests.$inferInsert> = {}) {
  const [row] = await db
    .insert(paymentRequests)
    .values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      reference: `MW-${newPublicId().slice(0, 4)}`,
      amountCents: 42_000,
      dueOn: "2026-10-20",
      note: "Website build (agreed price)",
      status: "open",
      ...values,
    })
    .returning();
  return row!;
}

describe("what a client owes for their site", () => {
  it("is the published build price for a client who has never paid", async () => {
    const tenant = await freshClient();
    const offer = await getWelcomeOffer(db, tenant.ctx);

    expect(offer?.siteDue).toEqual({ kind: "build", amountCents: BUILD.priceCents });
    expect(offer?.plans?.map((p) => p.key)).toEqual(PLANS.map((p) => p.key));
    expect(offer?.stripeReady).toBe(true);
  });

  it("is nothing once they have paid", async () => {
    const tenant = await freshClient();
    await recordPayment(tenant);

    expect(await getWelcomeOffer(db, tenant.ctx)).toMatchObject({ siteDue: { kind: "none", reason: "paid" } });
  });

  it("is nothing, and no plan to choose, for a complimentary client", async () => {
    const tenant = await freshClient();
    await db.update(clients).set({ compPlanId: await compPlanId() }).where(eq(clients.id, tenant.clientId));

    expect(await getWelcomeOffer(db, tenant.ctx)).toMatchObject({
      siteDue: { kind: "none", reason: "complimentary" },
      plans: null,
    });
  });

  it("is the invoice an operator raised, rather than the list price", async () => {
    const tenant = await freshClient();
    const invoice = await raiseInvoice(tenant);

    expect((await getWelcomeOffer(db, tenant.ctx))?.siteDue).toMatchObject({
      kind: "invoice",
      publicId: invoice.publicId,
      amountCents: 42_000,
      others: 0,
    });
  });

  it("ignores a one-off extra change, which is not what the site costs", async () => {
    const tenant = await freshClient();
    await raiseInvoice(tenant, { purpose: "extra_change", amountCents: 2500, dueOn: null });

    expect((await getWelcomeOffer(db, tenant.ctx))?.siteDue.kind).toBe("build");
  });

  it("does not mistake a paying client's monthly invoice for their site", async () => {
    const tenant = await freshClient();
    await recordPayment(tenant);
    await raiseInvoice(tenant, { amountCents: 5000, note: "November care plan" });

    expect((await getWelcomeOffer(db, tenant.ctx))?.siteDue).toEqual({ kind: "none", reason: "paid" });
  });

  it("is nothing when an operator cancelled the build invoice", async () => {
    const tenant = await freshClient();
    await raiseInvoice(tenant, { publicId: await buildInvoicePublicId(tenant.clientId), status: "cancelled" });

    expect(await siteDueFor(db, { ...tenant, compPlanId: null, isInternal: false, changeRequestsUnlockedAt: null })).toEqual({
      kind: "none",
      reason: "waived",
    });
  });
});

describe("beginWelcomeCheckout", () => {
  it("sends a plan, its add-ons and the build to Stripe as one subscription checkout", async () => {
    const tenant = await freshClient();

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, {
      planKey: "lite",
      addOns: ["reviews", "leads"],
      ...URLS,
    });

    expect(outcome).toMatchObject({ ok: true, mode: "subscription", reused: false });
    expect(fake.created).toHaveLength(1);
    const { params } = fake.created[0]!;
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([
      { price: "price_plan_lite", quantity: 1 },
      { price: "price_addon_reviews", quantity: 1 },
      {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: BUILD.priceCents, product_data: { name: "Website build" } },
      },
    ]);
    expect(params.subscription_data?.metadata).toMatchObject({ client_id: tenant.clientId, plan_key: "lite" });
    expect(params.metadata).toMatchObject({ source: "welcome", client_id: tenant.clientId });
    expect(params.success_url).toBe(URLS.successUrl);
  });

  it("hands back the open checkout when the same choice is made twice", async () => {
    const tenant = await freshClient();
    const choice = { planKey: "care", addOns: ["showcase"], ...URLS };

    const first = await beginWelcomeCheckout(db, tenant.ctx, choice);
    const second = await beginWelcomeCheckout(db, tenant.ctx, choice);
    const changed = await beginWelcomeCheckout(db, tenant.ctx, { ...choice, addOns: [] });

    expect(second).toMatchObject({ ok: true, reused: true });
    expect(first.ok && second.ok && first.url === second.url).toBe(true);
    expect(changed).toMatchObject({ ok: true, reused: false });
    expect(fake.created).toHaveLength(2);
  });

  it("charges the build alone as one payment against a single build invoice", async () => {
    const tenant = await freshClient();

    const first = await beginWelcomeCheckout(db, tenant.ctx, { planKey: null, addOns: [], ...URLS });
    const again = await beginWelcomeCheckout(db, tenant.ctx, { planKey: null, addOns: [], ...URLS });

    expect(first).toMatchObject({ ok: true, mode: "payment" });
    expect(again).toMatchObject({ ok: true, mode: "payment", reused: true });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.params.mode).toBe("payment");

    const invoices = await db.select().from(paymentRequests).where(eq(paymentRequests.clientId, tenant.clientId));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      publicId: await buildInvoicePublicId(tenant.clientId),
      amountCents: BUILD.priceCents,
      status: "open",
      note: "Website build",
      provider: "stripe",
    });
    expect(fake.created[0]!.params.metadata).toMatchObject({ payment_request_id: invoices[0]!.publicId });

    const raised = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, tenant.organizationId), eq(auditLog.action, "payment_request.raised")));
    expect(raised).toHaveLength(1);
  });

  it("leaves an operator's invoice out of the plan checkout", async () => {
    const tenant = await freshClient();
    await raiseInvoice(tenant);

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: "care", addOns: [], ...URLS });

    expect(outcome).toMatchObject({ ok: true, mode: "subscription" });
    expect(fake.created[0]!.params.line_items).toEqual([{ price: "price_plan_care", quantity: 1 }]);
  });

  it("pays an operator's invoice, for its own amount, when nothing else is chosen", async () => {
    const tenant = await freshClient();
    const invoice = await raiseInvoice(tenant);

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: null, addOns: [], ...URLS });

    expect(outcome).toMatchObject({ ok: true, mode: "payment" });
    expect(fake.created[0]!.params.metadata).toMatchObject({ payment_request_id: invoice.publicId });
    expect(fake.created[0]!.params.line_items?.[0]?.price_data?.unit_amount).toBe(42_000);
  });

  it("refuses add-ons without a plan, before anything reaches Stripe", async () => {
    const tenant = await freshClient();

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: null, addOns: ["reviews"], ...URLS });

    expect(outcome).toMatchObject({ ok: false, reason: "add_on_needs_plan" });
    expect(fake.created).toHaveLength(0);
  });

  it("refuses the test plan unless an operator assigned it", async () => {
    const tenant = await freshClient();

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: "test-plan", addOns: [], ...URLS });

    expect(outcome).toMatchObject({ ok: false, reason: "unknown_plan" });
    expect(fake.created).toHaveLength(0);
  });

  it("refuses a complimentary client outright", async () => {
    const tenant = await freshClient();
    await db.update(clients).set({ compPlanId: await compPlanId() }).where(eq(clients.id, tenant.clientId));

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: "care", addOns: [], ...URLS });

    expect(outcome).toMatchObject({ ok: false, reason: "complimentary" });
    expect(fake.created).toHaveLength(0);
  });

  it("refuses a second subscription for a client Stripe already bills", async () => {
    const tenant = await freshClient();
    fake.liveSubscription = true;

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: "care", addOns: [], ...URLS });

    expect(outcome).toMatchObject({ ok: false, reason: "already_subscribed" });
    expect(fake.created).toHaveLength(0);
  });

  it("says there is nothing to pay when the site is paid and nothing is chosen", async () => {
    const tenant = await freshClient();
    await recordPayment(tenant);

    expect(await beginWelcomeCheckout(db, tenant.ctx, { planKey: null, addOns: [], ...URLS })).toMatchObject({
      ok: false,
      reason: "nothing_to_pay",
    });
  });

  it("says so plainly, and writes nothing, when card payments are not set up", async () => {
    const tenant = await freshClient();
    fake.configured = false;

    const outcome = await beginWelcomeCheckout(db, tenant.ctx, { planKey: null, addOns: [], ...URLS });

    expect(outcome).toMatchObject({ ok: false, reason: "not_configured" });
    expect(await db.select().from(paymentRequests).where(eq(paymentRequests.clientId, tenant.clientId))).toEqual([]);
  });

  it("refuses to act while an operator is only viewing as the client", async () => {
    const tenant = await freshClient();
    const viewing = { ...tenant.ctx, impersonating: true };

    await expect(beginWelcomeCheckout(db, viewing, { planKey: null, addOns: [], ...URLS })).rejects.toThrow();
  });

  it("is not reused by choosing a plan from Billing, which must not carry the build", async () => {
    const tenant = await freshClient();
    await beginWelcomeCheckout(db, tenant.ctx, { planKey: "care", addOns: [], ...URLS });

    const fromBilling = await beginStripeCheckout(db, tenant.ctx, { planKey: "care", ...URLS });

    expect(fromBilling).toMatchObject({ ok: true, reused: false });
    expect(fake.created).toHaveLength(2);
    expect(fake.created[1]!.params.line_items).toEqual([{ price: "price_plan_care", quantity: 1 }]);
  });

  it("never charges for a feature that is free or not built", async () => {
    const tenant = await freshClient();
    const free = GROWTH_FEATURES.filter((f) => f.includedFrom === "free" && f.available).map((f) => f.key);

    await beginWelcomeCheckout(db, tenant.ctx, { planKey: "pro", addOns: free, ...URLS });

    expect(fake.created[0]!.params.line_items?.filter((i) => "price" in i && String(i.price).startsWith("price_addon")))
      .toEqual([]);
  });
});
