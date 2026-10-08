import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { clientAddOns, clients, leads, servicePlans, sites, subscriptions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { growthAccess, hasFeature } from "@/lib/growth/access";
import { AuthorizationError, adminContextFrom, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Growth access, add-ons and self-serve plan changes.
 *
 * What would go wrong quietly: a stray plan key unlocking a paid feature; an
 * unbuilt feature being sold; an add-on line on a subscription being read as
 * the plan; a hand-granted add-on being cancellable by the client; and Stripe
 * changing while the portal does not.
 */

const stripeCalls: Array<{ op: string; args: unknown }> = [];
let liveSubscription: Partial<Stripe.Subscription>;

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    stripeConfigured: () => true,
    priceForAddOn: async (feature: string) => ({ id: `price_addon_${feature}`, unit_amount: 1500 }),
    priceForPlan: async (key: string) => ({ id: `price_${key}`, lookup_key: `${key}_monthly_v2`, unit_amount: 10000 }),
    requireStripe: () => ({
      subscriptionItems: {
        create: async (args: unknown) => {
          stripeCalls.push({ op: "item.create", args });
          return { id: "si_new" };
        },
        del: async (id: string, args: unknown) => {
          stripeCalls.push({ op: "item.del", args: { id, ...(args as object) } });
          return { id, deleted: true };
        },
      },
      subscriptions: {
        retrieve: async () => liveSubscription,
        update: async (id: string, args: unknown) => {
          stripeCalls.push({ op: "sub.update", args: { id, ...(args as object) } });
          return { id };
        },
      },
    }),
  };
});

let db: Database;
let close: () => Promise<void>;

async function planId(key: string) {
  const [row] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, key));
  return row!.id;
}

async function subscribe(tenant: SeededTenant, planKey: string, provider: string | null = "stripe") {
  await db.insert(subscriptions).values({
    publicId: newPublicId(),
    clientId: tenant.clientId,
    planId: await planId(planKey),
    monthlyPriceCents: 2500,
    billingDay: 1,
    startedOn: "2026-10-01",
    provider,
    providerSubscriptionId: provider === "stripe" ? `sub_${tenant.clientId.slice(0, 8)}` : null,
    status: "active",
  });
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  stripeCalls.length = 0;
  liveSubscription = {
    id: "sub_x",
    items: {
      data: [
        { id: "si_addon", price: { lookup_key: "addon_leads_monthly_v1" } },
        { id: "si_plan", price: { lookup_key: "lite_monthly_v2" } },
      ],
    } as never,
  };
});

// ---------------------------------------------------------------------------

describe("who has what", () => {
  it("gives Lite no Growth tools, but offers the built ones as add-ons", () => {
    const access = growthAccess({ planKey: "lite", comped: false, addOns: [] });
    expect(access.every((a) => a.via === null)).toBe(true);
    expect(access.find((a) => a.feature.key === "leads")!.canAdd).toBe(true);
    // Not built yet: never offered for sale.
    expect(access.find((a) => a.feature.key === "reviews")!.canAdd).toBe(false);
  });

  it("includes the leads inbox from Care up, through the plan", () => {
    for (const key of ["care", "growth", "pro"]) {
      expect(growthAccess({ planKey: key, comped: false, addOns: [] }).find((a) => a.feature.key === "leads")!.via).toBe("plan");
    }
  });

  it("gives a complimentary client everything", () => {
    expect(growthAccess({ planKey: "comp-unlimited", comped: true, addOns: [] }).every((a) => a.via === "comp")).toBe(true);
  });

  it("counts an add-on, and never lets an unknown plan key unlock anything", () => {
    expect(hasFeature(growthAccess({ planKey: "lite", comped: false, addOns: ["leads"] }), "leads")).toBe(true);
    expect(growthAccess({ planKey: "test-plan", comped: false, addOns: [] }).every((a) => a.via === null)).toBe(true);
    expect(growthAccess({ planKey: "care-basic", comped: false, addOns: [] }).every((a) => a.via === null)).toBe(true);
  });

  it("says when upgrading is the better deal", () => {
    const reviews = growthAccess({ planKey: "care", comped: false, addOns: [] }).find((a) => a.feature.key === "reviews")!;
    expect(reviews.upgradeTo.key).toBe("growth");
    expect(reviews.upgradeSavesCents).toBeGreaterThan(0);
  });
});

describe("the plan line on a subscription", () => {
  it("is the plan's price, not whichever line Stripe lists first", async () => {
    const { planItemOf, addOnItemsOf } = await import("@/lib/payments/stripe");
    expect(planItemOf(liveSubscription as Stripe.Subscription)!.id).toBe("si_plan");
    expect(addOnItemsOf(liveSubscription as Stripe.Subscription).map((a) => a.feature)).toEqual(["leads"]);
  });
});

describe("self-serve changes", () => {
  let lite: SeededTenant;
  let invoiced: SeededTenant;

  beforeAll(async () => {
    lite = await seedTenant(db, "Lite Co");
    await subscribe(lite, "lite");
    invoiced = await seedTenant(db, "Invoiced Co");
    await subscribe(invoiced, "care", null);
  });

  it("adds a built feature to the client's own Stripe subscription, from the next payment", async () => {
    const { addGrowthAddOn, getGrowthState } = await import("@/db/repositories/client/growth");
    const result = await addGrowthAddOn(db, lite.ctx, "leads");
    expect(result.ok).toBe(true);
    expect(stripeCalls[0]).toMatchObject({
      op: "item.create",
      args: { subscription: `sub_${lite.clientId.slice(0, 8)}`, price: "price_addon_leads", proration_behavior: "none" },
    });
    const state = await getGrowthState(db, lite.ctx);
    expect(state.access.find((a) => a.feature.key === "leads")!.via).toBe("add-on");
  });

  it("refuses an unbuilt feature, one they already have, and changes for an invoiced client", async () => {
    const { addGrowthAddOn } = await import("@/db/repositories/client/growth");
    expect((await addGrowthAddOn(db, lite.ctx, "reviews")).ok).toBe(false);
    expect((await addGrowthAddOn(db, lite.ctx, "leads")).ok).toBe(false);
    expect((await addGrowthAddOn(db, invoiced.ctx, "campaigns")).ok).toBe(false);
    expect(stripeCalls).toHaveLength(0);
  });

  it("moves the plan line to the new plan without touching the add-on line", async () => {
    const { changeMyPlan } = await import("@/db/repositories/client/growth");
    const result = await changeMyPlan(db, lite.ctx, "growth");
    expect(result.ok).toBe(true);
    expect(stripeCalls[0]).toMatchObject({
      op: "sub.update",
      args: { items: [{ id: "si_plan", price: "price_growth" }], proration_behavior: "none" },
    });
    const [sub] = await db
      .select({ key: servicePlans.key })
      .from(subscriptions)
      .innerJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
      .where(eq(subscriptions.clientId, lite.clientId));
    expect(sub!.key).toBe("growth");
  });

  it("schedules a cancellation at period end, and undoes it", async () => {
    const { setPlanCancellation, getGrowthState } = await import("@/db/repositories/client/growth");
    await setPlanCancellation(db, lite.ctx, true);
    expect(stripeCalls.at(-1)).toMatchObject({ op: "sub.update", args: { cancel_at_period_end: true } });
    const [row] = await db.select({ c: subscriptions.cancelAtPeriodEnd }).from(subscriptions).where(eq(subscriptions.clientId, lite.clientId));
    expect(row!.c).toBe(true);
    await setPlanCancellation(db, lite.ctx, false);
    expect((await getGrowthState(db, lite.ctx)).cancelsOn).toBeNull();
  });

  it("refuses every change while an operator is viewing as the client", async () => {
    const { addGrowthAddOn, setPlanCancellation } = await import("@/db/repositories/client/growth");
    const operator = tenantContextFrom(
      { userId: lite.userId, organizationId: lite.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      lite.organizationId,
      { impersonating: true },
    );
    await expect(addGrowthAddOn(db, operator, "leads")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(setPlanCancellation(db, operator, true)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("removes a card add-on at Stripe, but never one the operator granted", async () => {
    const { removeGrowthAddOn } = await import("@/db/repositories/client/growth");
    expect((await removeGrowthAddOn(db, lite.ctx, "leads")).ok).toBe(true);
    expect(stripeCalls.at(-1)).toMatchObject({ op: "item.del", args: { id: "si_new" } });

    await db.insert(clientAddOns).values({ clientId: invoiced.clientId, featureKey: "leads", source: "operator" });
    expect((await removeGrowthAddOn(db, invoiced.ctx, "leads")).ok).toBe(false);
  });

  it("counts waiting enquiries for a client whose plan does not include the inbox", async () => {
    const { getGrowthState } = await import("@/db/repositories/client/growth");
    const shop = await seedTenant(db, "Locked Shop");
    await subscribe(shop, "lite");
    const [site] = await db.insert(sites).values({ publicId: newPublicId(), organizationId: shop.organizationId, name: "s" }).returning({ id: sites.id });
    await db.insert(leads).values({
      publicId: newPublicId(),
      organizationId: shop.organizationId,
      siteId: site!.id,
      providerSubmissionId: newPublicId(),
      receivedAt: new Date(),
    });
    const state = await getGrowthState(db, shop.ctx);
    expect(hasFeature(state.access, "leads")).toBe(false);
    expect(state.waitingLeads).toBe(1);
  });
});

describe("the webhook mirrors add-ons", () => {
  it("records an add-on line, and ends it when the line or the subscription goes", async () => {
    const { syncStripeAddOns } = await import("@/db/repositories/admin/stripe-webhooks");
    const t = await seedTenant(db, "Mirror Co");
    const live = (status: string, withAddOn: boolean) =>
      ({
        status,
        items: {
          data: [
            { id: "si_p", price: { lookup_key: "care_monthly_v2", unit_amount: 5000 } },
            ...(withAddOn ? [{ id: "si_a", price: { lookup_key: "addon_leads_monthly_v1", unit_amount: 1500 } }] : []),
          ],
        },
      }) as unknown as Stripe.Subscription;

    const liveRows = () =>
      db.select().from(clientAddOns).where(and(eq(clientAddOns.clientId, t.clientId), isNull(clientAddOns.endedAt)));

    await syncStripeAddOns(db, t.clientId, live("active", true));
    expect(await liveRows()).toHaveLength(1);
    await syncStripeAddOns(db, t.clientId, live("active", true));
    expect(await liveRows()).toHaveLength(1);
    await syncStripeAddOns(db, t.clientId, live("active", false));
    expect(await liveRows()).toHaveLength(0);

    await syncStripeAddOns(db, t.clientId, live("active", true));
    await syncStripeAddOns(db, t.clientId, live("canceled", true));
    expect(await liveRows()).toHaveLength(0);
  });
});

describe("the operator's grants", () => {
  it("grants and removes a hand-given add-on, and leaves card ones to Stripe", async () => {
    const { grantAddOn, revokeAddOn, getClientGrowth } = await import("@/db/repositories/admin/growth");
    const t = await seedTenant(db, "Granted Co");
    const admin = adminContextFrom({ userId: t.userId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
    const [client] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, t.clientId));

    expect((await grantAddOn(admin, db, client!.publicId, "leads")).ok).toBe(true);
    expect((await grantAddOn(admin, db, client!.publicId, "leads")).ok).toBe(false);
    expect(hasFeature((await getClientGrowth(admin, db, client!.publicId)).access, "leads")).toBe(true);

    expect((await revokeAddOn(admin, db, client!.publicId, "leads")).ok).toBe(true);
    await db.insert(clientAddOns).values({ clientId: t.clientId, featureKey: "leads", source: "stripe", stripeSubscriptionItemId: "si_card" });
    expect((await revokeAddOn(admin, db, client!.publicId, "leads")).ok).toBe(false);
  });
});
