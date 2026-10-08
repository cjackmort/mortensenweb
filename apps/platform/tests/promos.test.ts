import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
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
 * Promos: Stripe promotion codes offered at checkout, attached by an operator,
 * and read back so the portal quotes what is actually charged.
 *
 * The failures worth testing:
 *
 *  - a client handed a promo who is charged full price anyway
 *  - a promo that has expired since it was attached stopping somebody paying
 *  - a Stripe outage silently dropping a promo that was promised
 *  - an open checkout from before a promo was attached being reused, so the
 *    client pays a price nobody meant to offer
 *  - a live subscription's promo price not reaching the portal
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;

type FakePromo = Pick<
  Stripe.PromotionCode,
  "id" | "code" | "active" | "expires_at" | "max_redemptions" | "times_redeemed" | "customer"
> & { promotion: { type: "coupon"; coupon: string }; restrictions: { first_time_transaction: boolean } };

const fake = {
  promos: new Map<string, FakePromo>(),
  coupons: new Map<string, Partial<Stripe.Coupon>>(),
  sessions: [] as Array<{ id: string; url: string; status: string; mode: string; metadata: Record<string, string>; line_items: { data: Array<{ price: { id: string } }> } }>,
  sessionParams: [] as Stripe.Checkout.SessionCreateParams[],
  updates: [] as Array<{ id: string; params: Stripe.SubscriptionUpdateParams }>,
  /** What `checkout.sessions.create` does with a promo: accept, refuse, or fail. */
  onPromo: "accept" as "accept" | "refuse" | "outage",
};

function stripeError(type: string, message: string): Error {
  return Object.assign(new Error(message), { type });
}

function expandedDiscount(promotionCodeId: string): Stripe.Discount {
  const promo = fake.promos.get(promotionCodeId)!;
  return {
    id: `di_${promotionCodeId}`,
    object: "discount",
    end: null,
    promotion_code: promo,
    source: { type: "coupon", coupon: fake.coupons.get(promo.promotion.coupon) },
  } as unknown as Stripe.Discount;
}

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>(
    "@/lib/payments/stripe",
  );
  return {
    ...actual,
    priceForPlan: async () => ({ id: "price_basic", lookup_key: "care_monthly_v2", unit_amount: 10000 }),
    requireStripe: () =>
      ({
        customers: {
          create: async () => ({ id: `cus_${Math.random().toString(36).slice(2)}` }),
        },
        coupons: {
          retrieve: async (id: string) => fake.coupons.get(id),
        },
        promotionCodes: {
          retrieve: async (id: string) => {
            const found = fake.promos.get(id);
            if (!found) throw stripeError("StripeInvalidRequestError", `No such promotion code: ${id}`);
            return found;
          },
          list: async () => ({ data: [...fake.promos.values()].filter((p) => p.active) }),
        },
        subscriptions: {
          list: async () => ({ data: [] }),
          update: async (id: string, params: Stripe.SubscriptionUpdateParams) => {
            fake.updates.push({ id, params });
            const discounts = (params.discounts || []) as Array<{ promotion_code: string }>;
            return { id, discounts: discounts.map((d) => expandedDiscount(d.promotion_code)) };
          },
        },
        checkout: {
          sessions: {
            list: async () => ({ data: fake.sessions.filter((s) => s.status === "open") }),
            create: async (params: Stripe.Checkout.SessionCreateParams) => {
              if (params.discounts && fake.onPromo === "refuse") {
                throw stripeError("StripeInvalidRequestError", "This promotion code cannot be redeemed.");
              }
              if (params.discounts && fake.onPromo === "outage") {
                throw stripeError("StripeConnectionError", "Could not connect to Stripe.");
              }
              fake.sessionParams.push(params);
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

const promos = await import("@/lib/payments/promos");
const { attachPromo } = await import("@/db/repositories/admin/promos");
const { beginStripeCheckout } = await import("@/db/repositories/client/stripe-checkout");

interface Tenant {
  clientId: string;
  publicId: string;
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
    ctx: tenantContextFrom(
      { userId: user.id, organizationId: org.id, role: "client", status: "active", sessionEpoch: 0 },
      org.id,
    ),
  };
}

async function putOnStripe(clientId: string) {
  const plan = (await db.select().from(servicePlans).where(eq(servicePlans.key, "care")))[0]!;
  await db.insert(subscriptions).values({
    publicId: newPublicId(),
    clientId,
    planId: plan.id,
    monthlyPriceCents: 10000,
    startedOn: "2026-09-01",
    provider: "stripe",
    providerSubscriptionId: "sub_live",
    providerStatus: "active",
  });
}

const URLS = {
  successUrl: "https://portal.test/dashboard/billing?checkout=complete",
  cancelUrl: "https://portal.test/dashboard/billing?checkout=cancelled",
};

const checkout = () => beginStripeCheckout(db, acme.ctx, { ...URLS, planKey: "care" });

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
  admin = adminContextFrom({ userId: adminUser.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  fake.promos.clear();
  fake.coupons.clear();
  fake.sessions.length = 0;
  fake.sessionParams.length = 0;
  fake.updates.length = 0;
  fake.onPromo = "accept";

  fake.coupons.set("co_half", {
    id: "co_half",
    valid: true,
    percent_off: 50,
    amount_off: null,
    duration: "repeating",
    duration_in_months: 3,
    redeem_by: null,
  });
  fake.promos.set("promo_spring", {
    id: "promo_spring",
    code: "SPRING50",
    active: true,
    expires_at: null,
    max_redemptions: null,
    times_redeemed: 0,
    customer: null,
    promotion: { type: "coupon", coupon: "co_half" },
    restrictions: { first_time_transaction: false },
  });

  await db.delete(subscriptions);
  acme = await seedTenant("acme");
});

describe("describing a promo", () => {
  it("says what it is in the client's terms", () => {
    expect(promos.couponTerms({ percent_off: 50, amount_off: null, duration: "repeating", duration_in_months: 3 })).toBe(
      "50% off for 3 months",
    );
    expect(promos.couponTerms({ percent_off: null, amount_off: 2500, duration: "once", duration_in_months: null })).toBe(
      "$25 off the first payment",
    );
    expect(promos.couponTerms({ percent_off: 100, amount_off: null, duration: "repeating", duration_in_months: 1 })).toBe(
      "100% off for 1 month",
    );
    expect(promos.couponTerms({ percent_off: null, amount_off: 1050, duration: "forever", duration_in_months: null })).toBe(
      "$10.50 off every month",
    );
  });

  it("never discounts below zero", () => {
    expect(promos.applyCoupon(5000, { percent_off: null, amount_off: 9000 })).toBe(0);
    expect(promos.applyCoupon(5000, { percent_off: 25, amount_off: null })).toBe(3750);
  });

  it("goes back to the list price once the promo's end date passes", () => {
    const row = {
      monthlyPriceCents: 10000,
      discountedPriceCents: 5000,
      discountEndsAt: new Date("2026-12-01T00:00:00Z"),
    };
    expect(promos.effectiveMonthlyCents(row, new Date("2026-11-30T00:00:00Z"))).toBe(5000);
    // A charge on the end date itself is at full price: Stripe has dropped
    // the discount by the time that invoice is made.
    expect(promos.effectiveMonthlyCents(row, new Date("2026-12-01T00:00:00Z"))).toBe(10000);
    expect(promos.effectiveMonthlyCents({ ...row, discountEndsAt: null }, new Date("2030-01-01"))).toBe(5000);
  });

  it("lists only codes that can still be redeemed by anybody", async () => {
    fake.promos.set("promo_used_up", {
      ...fake.promos.get("promo_spring")!,
      id: "promo_used_up",
      code: "GONE",
      max_redemptions: 5,
      times_redeemed: 5,
    });
    fake.promos.set("promo_one_customer", {
      ...fake.promos.get("promo_spring")!,
      id: "promo_one_customer",
      code: "JUSTYOU",
      customer: "cus_someone",
    });

    const options = await promos.listPromoOptions();
    expect(options.map((o) => o.code)).toEqual(["SPRING50"]);
    expect(options[0]).toMatchObject({ terms: "50% off for 3 months", firstTimeOnly: false });
  });
});

describe("checkout", () => {
  it("offers a box to type a code when no promo is attached", async () => {
    const outcome = await checkout();

    expect(outcome.ok).toBe(true);
    expect(fake.sessionParams[0]).toMatchObject({ allow_promotion_codes: true });
    expect(fake.sessionParams[0]!.discounts).toBeUndefined();
  });

  it("applies an attached promo for them", async () => {
    await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });

    const outcome = await checkout();

    expect(outcome.ok).toBe(true);
    const params = fake.sessionParams[0]!;
    expect(params.discounts).toEqual([{ promotion_code: "promo_spring" }]);
    // Stripe refuses a session that has both.
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.metadata?.promo_code_id).toBe("promo_spring");
  });

  it("drops a promo that has expired since it was attached, rather than blocking payment", async () => {
    await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });
    fake.promos.get("promo_spring")!.active = false;

    const outcome = await checkout();

    expect(outcome.ok).toBe(true);
    expect(fake.sessionParams[0]!.discounts).toBeUndefined();
    expect(fake.sessionParams[0]!.allow_promotion_codes).toBe(true);
  });

  it("carries on without the promo when Stripe refuses it for this customer", async () => {
    await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });
    fake.onPromo = "refuse";

    const outcome = await checkout();

    expect(outcome.ok).toBe(true);
    expect(fake.sessionParams).toHaveLength(1);
    expect(fake.sessionParams[0]!.discounts).toBeUndefined();
    expect(fake.sessionParams[0]!.allow_promotion_codes).toBe(true);
  });

  it("does not quietly drop a promo because Stripe was unreachable", async () => {
    await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });
    fake.onPromo = "outage";

    const outcome = await checkout();

    expect(outcome).toMatchObject({ ok: false, reason: "stripe_failed" });
    expect(fake.sessionParams).toHaveLength(0);
  });

  it("does not reuse a checkout opened before the promo was attached", async () => {
    const before = await checkout();
    await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });

    const after = await checkout();

    expect(after.ok && before.ok && after.url).not.toBe(before.ok && before.url);
    expect(after).toMatchObject({ ok: true, reused: false });
  });
});

describe("an operator attaching a promo", () => {
  it("saves it for the checkout of a client not yet paying by card", async () => {
    const result = await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });

    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("SPRING50");
    const row = (await db.select().from(clients).where(eq(clients.id, acme.clientId)))[0]!;
    expect(row).toMatchObject({
      promoCodeId: "promo_spring",
      promoCode: "SPRING50",
      promoTerms: "50% off for 3 months",
    });
    expect(fake.updates).toHaveLength(0);
  });

  it("puts it on the live subscription of a client already paying by card", async () => {
    await putOnStripe(acme.clientId);

    const result = await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });

    expect(result).toMatchObject({ ok: true });
    expect(fake.updates[0]).toMatchObject({
      id: "sub_live",
      params: { discounts: [{ promotion_code: "promo_spring" }] },
    });
    const row = (await db.select().from(subscriptions).where(eq(subscriptions.clientId, acme.clientId)))[0]!;
    expect(row).toMatchObject({
      monthlyPriceCents: 10000,
      discountedPriceCents: 5000,
      discountLabel: "SPRING50: 50% off for 3 months",
    });
  });

  it("refuses a code that can no longer be redeemed", async () => {
    fake.promos.get("promo_spring")!.active = false;

    const result = await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });

    expect(result.ok).toBe(false);
    const row = (await db.select().from(clients).where(eq(clients.id, acme.clientId)))[0]!;
    expect(row.promoCodeId).toBeNull();
  });

  it("refuses a client on a free plan", async () => {
    const comp = (await db.select().from(servicePlans).where(eq(servicePlans.key, "comp-unlimited")))[0]!;
    await db.update(clients).set({ compPlanId: comp.id }).where(eq(clients.id, acme.clientId));

    const result = await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });

    expect(result.ok).toBe(false);
  });

  it("removes a saved promo, and never takes one off a live subscription", async () => {
    await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: "promo_spring" });
    await putOnStripe(acme.clientId);

    const result = await attachPromo(admin, db, { clientPublicId: acme.publicId, promoCodeId: null });

    expect(result.ok).toBe(true);
    const row = (await db.select().from(clients).where(eq(clients.id, acme.clientId)))[0]!;
    expect(row.promoCodeId).toBeNull();
    expect(fake.updates).toHaveLength(0);
  });
});
