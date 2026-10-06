import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  organizations,
  servicePlans,
  subscriptions,
  users,
} from "@/db/schema";
import {
  adminContextFrom,
  tenantContextFrom,
  type AdminContext,
  type TenantContext,
} from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * An operator choosing a client's plan and the day they pay.
 *
 * The choice has to reach the money: it is the plan the client is offered at
 * checkout, the day Stripe charges them, and — once they are on Stripe — a
 * change to the live subscription. The failures worth testing:
 *
 *  - the client offered a plan nobody assigned them
 *  - a plan with no price (the comp plan) becoming something to pay for
 *  - a client already on Stripe charged twice for days they paid for
 *  - a locked-in price silently re-priced because the day changed
 *  - a Square mandate edited from a screen that cannot reach Square
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;

const fake = {
  prices: new Map<string, { id: string; lookup_key: string; unit_amount: number }>([
    ["lite_monthly_v2", { id: "price_lite", lookup_key: "lite_monthly_v2", unit_amount: 5000 }],
    ["care_monthly_v2", { id: "price_basic", lookup_key: "care_monthly_v2", unit_amount: 10000 }],
    ["test_plan_monthly_v1", { id: "price_test", lookup_key: "test_plan_monthly_v1", unit_amount: 100 }],
    ["growth_monthly_v2", { id: "price_plus", lookup_key: "growth_monthly_v2", unit_amount: 20000 }],
  ]),
  subscriptions: new Map<string, Stripe.Subscription>(),
  updates: [] as Array<{ id: string; params: Stripe.SubscriptionUpdateParams }>,
  sessions: [] as Array<{ id: string; url: string; status: string; mode: string; metadata: Record<string, string>; line_items: { data: Array<{ price: { id: string } }> } }>,
  sessionParams: [] as Stripe.Checkout.SessionCreateParams[],
  idempotencyKeys: [] as string[],
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>(
    "@/lib/payments/stripe",
  );
  return {
    ...actual,
    // Resolves through `requireStripe` inside its own module, which this mock
    // cannot reach, so it is faked at the same edge.
    priceForPlan: async (key: Parameters<typeof actual.priceForPlan>[0]) =>
      fake.prices.get(actual.lookupKeyForPlan(key) ?? "") ?? null,
    requireStripe: () =>
      ({
        prices: {
          list: async ({ lookup_keys }: { lookup_keys: string[] }) => ({
            data: lookup_keys.map((k) => fake.prices.get(k)).filter(Boolean),
          }),
        },
        customers: {
          create: async () => ({ id: `cus_${Math.random().toString(36).slice(2)}` }),
        },
        subscriptions: {
          list: async () => ({ data: [] }),
          retrieve: async (id: string) => {
            const found = fake.subscriptions.get(id);
            if (!found) throw new Error(`no such subscription ${id}`);
            return found;
          },
          update: async (id: string, params: Stripe.SubscriptionUpdateParams) => {
            fake.updates.push({ id, params });
            return fake.subscriptions.get(id);
          },
        },
        checkout: {
          sessions: {
            list: async () => ({ data: fake.sessions.filter((s) => s.status === "open") }),
            create: async (
              params: Stripe.Checkout.SessionCreateParams,
              options?: Stripe.RequestOptions,
            ) => {
              fake.sessionParams.push(params);
              fake.idempotencyKeys.push(String(options?.idempotencyKey));
              const session = {
                id: `cs_${fake.sessions.length + 1}`,
                url: `https://checkout.stripe.test/${fake.sessions.length + 1}`,
                status: "open",
                mode: "subscription",
                metadata: (params.metadata ?? {}) as Record<string, string>,
                line_items: { data: [{ price: { id: String(params.line_items?.[0]?.price) } }] },
              };
              fake.sessions.push(session);
              return session;
            },
          },
        },
      }) as never,
  };
});

const { assignBillingPlan, getBillingPlan, listAssignablePlans } = await import(
  "@/db/repositories/admin/billing-plan"
);
const { beginStripeCheckout, beginCheckoutForClient } = await import(
  "@/db/repositories/client/stripe-checkout"
);
const { getEntitlements } = await import("@/db/repositories/client/entitlements");
const { getPlanChoice } = await import("@/db/repositories/client/plan-choice");

interface Tenant {
  clientId: string;
  publicId: string;
  orgId: string;
  ctx: TenantContext;
}

let acme: Tenant;

async function seedTenant(name: string): Promise<Tenant> {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name, slug: `${name}-${newPublicId().toLowerCase()}`, kind: "client" })
      .returning()
  )[0]!;
  const user = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: `${newPublicId().toLowerCase()}@example.test`, role: "client", status: "active" })
      .returning()
  )[0]!;
  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id, primaryContactEmail: `${name}@example.test` })
      .returning()
  )[0]!;
  return {
    clientId: client.id,
    publicId: client.publicId,
    orgId: org.id,
    ctx: tenantContextFrom(
      { userId: user.id, organizationId: org.id, role: "client", status: "active", sessionEpoch: 0 },
      org.id,
    ),
  };
}

async function planId(key: string): Promise<string> {
  const rows = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, key));
  return rows[0]!.id;
}

async function activeRows(clientId: string) {
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.clientId, clientId), eq(subscriptions.status, "active")));
}

const URLS = {
  successUrl: "https://portal.test/dashboard/billing?checkout=complete",
  cancelUrl: "https://portal.test/dashboard/billing?checkout=cancelled",
};

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";

  const adminUser = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" })
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
  fake.subscriptions.clear();
  fake.updates.length = 0;
  fake.sessions.length = 0;
  fake.sessionParams.length = 0;
  fake.idempotencyKeys.length = 0;
  vi.useRealTimers();
  // Subscriptions are unique per Stripe id; each test starts without any.
  await db.delete(subscriptions);
  acme = await seedTenant("acme");
});

describe("the plans an operator can choose", () => {
  it("offers every plan Stripe can charge for, test plan last", async () => {
    const plans = await listAssignablePlans(db);
    const keys = plans.map((p) => p.key);

    expect(keys).toEqual(["lite", "care", "growth", "pro", "test-plan"]);
    expect(plans.at(-1)).toMatchObject({ name: "Test plan", monthlyCents: 100 });
  });

  it("never offers the complimentary plan as something to pay for", async () => {
    const keys = (await listAssignablePlans(db)).map((p) => p.key);
    expect(keys).not.toContain("comp-unlimited");
  });
});

describe("assigning a plan to a client who is not on Stripe", () => {
  it("records the plan and the day, and that is what they are offered", async () => {
    const result = await assignBillingPlan(admin, db, {
      clientPublicId: acme.publicId,
      planKey: "care",
      billingDay: 15,
    });

    expect(result.ok).toBe(true);
    const rows = await activeRows(acme.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      planId: await planId("care"),
      monthlyPriceCents: 5000,
      billingDay: 15,
      provider: null,
    });

    const entitlements = await getEntitlements(db, acme.ctx);
    expect(entitlements?.planKey).toBe("care");
  });

  it("moves the day without re-pricing a plan whose price was locked in", async () => {
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "care", billingDay: 1 });
    // Agreed at an older price, before the published one went up.
    await db
      .update(subscriptions)
      .set({ monthlyPriceCents: 9900 })
      .where(eq(subscriptions.clientId, acme.clientId));

    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "care", billingDay: 20 });

    const rows = await activeRows(acme.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ billingDay: 20, monthlyPriceCents: 9900 });
  });

  it("prices a new plan at that plan's price", async () => {
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "care", billingDay: 1 });
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 1 });

    const rows = await activeRows(acme.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ planId: await planId("test-plan"), monthlyPriceCents: 100 });
  });

  it("writes who changed it to the audit log", async () => {
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "lite", billingDay: 3 });
    const entries = await db.select().from(auditLog).where(eq(auditLog.organizationId, acme.orgId));
    expect(entries.at(-1)).toMatchObject({
      action: "subscription.assigned",
      metadata: expect.objectContaining({ planKey: "lite", billingDay: 3 }),
    });
  });

  it("refuses a plan with no price, an unknown plan, and an impossible day", async () => {
    const comp = await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "comp-unlimited", billingDay: 1 });
    const unknown = await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "gold", billingDay: 1 });
    const day = await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "lite", billingDay: 31 });

    expect([comp.ok, unknown.ok, day.ok]).toEqual([false, false, false]);
    expect(await activeRows(acme.clientId)).toHaveLength(0);
  });

  it("leaves a Square mandate alone", async () => {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      planId: await planId("care"),
      monthlyPriceCents: 10000,
      billingDay: 1,
      startedOn: "2026-09-01",
      provider: "square",
      providerSubscriptionId: "sq_1",
    });

    const result = await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "growth", billingDay: 9 });

    expect(result).toMatchObject({ ok: false });
    const rows = await activeRows(acme.clientId);
    expect(rows[0]).toMatchObject({ provider: "square", billingDay: 1 });
  });
});

describe("checkout follows the assignment", () => {
  it("anchors the subscription on the chosen day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 15 });

    const outcome = await beginStripeCheckout(db, acme.ctx, { planKey: "test-plan", ...URLS });

    expect(outcome.ok).toBe(true);
    const params = fake.sessionParams.at(-1)!;
    expect(params.line_items?.[0]?.price).toBe("price_test");
    expect(params.subscription_data?.billing_cycle_anchor_config).toEqual({ day_of_month: 15 });
  });

  it("starts billing today when today is the chosen day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T18:00:00Z"));
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 15 });

    await beginStripeCheckout(db, acme.ctx, { planKey: "test-plan", ...URLS });

    expect(fake.sessionParams.at(-1)!.subscription_data?.billing_cycle_anchor_config).toBeUndefined();
  });

  it("does not reuse an open checkout made for a different day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 15 });
    const first = await beginStripeCheckout(db, acme.ctx, { planKey: "test-plan", ...URLS });

    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 20 });
    const second = await beginStripeCheckout(db, acme.ctx, { planKey: "test-plan", ...URLS });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.url).not.toBe(first.url);
    expect(new Set(fake.idempotencyKeys).size).toBe(2);
    expect(fake.sessionParams.at(-1)!.subscription_data?.billing_cycle_anchor_config).toEqual({ day_of_month: 20 });
  });

  it("gives the operator a payment link for the assigned plan", async () => {
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 15 });

    const outcome = await beginCheckoutForClient(admin, db, acme.publicId, URLS);

    expect(outcome.ok).toBe(true);
    expect(fake.sessionParams.at(-1)!.line_items?.[0]?.price).toBe("price_test");
  });

  it("has no payment link to give before a plan is chosen", async () => {
    const outcome = await beginCheckoutForClient(admin, db, acme.publicId, URLS);
    expect(outcome).toMatchObject({ ok: false, reason: "unknown_plan" });
    expect(fake.sessionParams).toHaveLength(0);
  });
});

describe("a client already paying through Stripe", () => {
  const SUB = "sub_live_1";
  const periodEnd = Math.floor(Date.parse("2026-11-05T15:30:00Z") / 1000);

  async function onStripe(lookupKey = "care_monthly_v2") {
    fake.subscriptions.set(SUB, {
      id: SUB,
      status: "active",
      metadata: { client_id: acme.clientId, plan_key: "care" },
      items: {
        data: [{ id: "si_1", current_period_end: periodEnd, price: { id: "price_basic", lookup_key: lookupKey } }],
      },
    } as unknown as Stripe.Subscription);

    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      planId: await planId("care"),
      monthlyPriceCents: 10000,
      billingDay: 5,
      startedOn: "2026-10-05",
      provider: "stripe",
      providerSubscriptionId: SUB,
      providerStatus: "active",
    });
  }

  it("changes the price from their next payment, without charging now", async () => {
    await onStripe();

    const result = await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "lite", billingDay: 5 });

    expect(result.ok).toBe(true);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.params).toMatchObject({
      items: [{ id: "si_1", price: "price_lite" }],
      proration_behavior: "none",
    });
    expect(fake.updates[0]!.params.trial_end).toBeUndefined();
  });

  it("moves the payment day to after the period they already paid for", async () => {
    await onStripe();

    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "care", billingDay: 15 });

    expect(fake.updates).toHaveLength(1);
    const params = fake.updates[0]!.params;
    expect(params.items).toBeUndefined();
    expect(params.proration_behavior).toBe("none");
    expect(params.trial_end).toBe(Math.floor(Date.parse("2026-11-15T15:30:00Z") / 1000));
    expect(Number(params.trial_end)).toBeGreaterThan(periodEnd);

    const rows = await activeRows(acme.clientId);
    expect(rows[0]).toMatchObject({ provider: "stripe", billingDay: 15 });
  });

  it("does not touch Stripe when nothing changed", async () => {
    await onStripe();

    const result = await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "care", billingDay: 5 });

    expect(result.ok).toBe(true);
    expect(fake.updates).toHaveLength(0);
  });

  it("does not open a second hand-billed plan beside the Stripe one", async () => {
    await onStripe();

    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "growth", billingDay: 5 });

    expect(await activeRows(acme.clientId)).toHaveLength(1);
  });

  it("reports what Stripe is billing", async () => {
    await onStripe();
    const view = await getBillingPlan(db, acme.clientId);
    expect(view).toMatchObject({ planKey: "care", billingDay: 5, provider: "stripe" });
  });
});

describe("a client choosing their own plan", () => {
  it("cannot buy the test plan unless an operator assigned it", async () => {
    const outcome = await beginStripeCheckout(db, acme.ctx, { planKey: "test-plan", ...URLS });

    expect(outcome).toMatchObject({ ok: false, reason: "unknown_plan" });
    expect(fake.sessionParams).toHaveLength(0);
  });

  it("can choose a bigger plan than the one assigned, still on the assigned day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T18:00:00Z"));
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "lite", billingDay: 15 });

    const outcome = await beginStripeCheckout(db, acme.ctx, { planKey: "growth", ...URLS });

    expect(outcome.ok).toBe(true);
    const params = fake.sessionParams.at(-1)!;
    expect(params.line_items?.[0]?.price).toBe("price_plus");
    expect(params.subscription_data?.billing_cycle_anchor_config).toEqual({ day_of_month: 15 });
  });

  it("is shown every published plan with what it includes", async () => {
    const choice = await getPlanChoice(db, acme.ctx);

    expect(choice.open).toBe(true);
    if (!choice.open) return;
    expect(choice.plans.map((p) => p.key)).toEqual(["lite", "care", "growth", "pro"]);
    expect(choice.plans.every((p) => p.features.length > 0)).toBe(true);
    expect(choice.plans.find((p) => p.featured)?.key).toBe("care");
  });

  it("sees the plan an operator assigned marked for them, and the test plan only then", async () => {
    await assignBillingPlan(admin, db, { clientPublicId: acme.publicId, planKey: "test-plan", billingDay: 9 });

    const choice = await getPlanChoice(db, acme.ctx);

    expect(choice.open).toBe(true);
    if (!choice.open) return;
    expect(choice.plans.at(-1)).toMatchObject({ key: "test-plan", recommended: true, monthlyCents: 100 });
    expect(choice.plans.filter((p) => p.recommended)).toHaveLength(1);
    expect(choice.billingDay).toBe(9);
  });

  it("has nothing to choose for a client on a free plan", async () => {
    await db
      .update(clients)
      .set({ compPlanId: await planId("comp-unlimited") })
      .where(eq(clients.id, acme.clientId));

    expect(await getPlanChoice(db, acme.ctx)).toEqual({ open: false, reason: "complimentary" });
  });

  it("has nothing to choose for a client Stripe is already charging", async () => {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      planId: await planId("care"),
      monthlyPriceCents: 10000,
      billingDay: 1,
      startedOn: "2026-10-01",
      provider: "stripe",
      providerSubscriptionId: "sub_choice_1",
    });

    expect(await getPlanChoice(db, acme.ctx)).toEqual({ open: false, reason: "subscribed" });
  });
});
