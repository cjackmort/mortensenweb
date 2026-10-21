import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { BUILDS, GROWTH_FEATURES, PLANS } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { clients, payments, servicePlans, subscriptions } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";
import { addCoupon, addPrice, addPromo, addSubscription, fakeStripe, resetFakeStripe } from "./helpers/fake-stripe";

/**
 * The cart: a new client's website build, an optional plan and add-ons, as
 * one payment.
 *
 * The failures worth testing are the ones that charge the wrong amount or
 * charge twice: a browser choosing its own price, a cheaper build, an add-on
 * the plan already includes, a code that also discounts the plan, a client
 * who has paid being asked again, two open checkouts for one client, and a
 * Stripe price that disagrees with the one on screen.
 */

// The add-on on sale is pinned here, so the suite does not depend on which
// Growth features happen to be built when it runs.
const ADD_ON = GROWTH_FEATURES.find((f) => f.key === "reviews")!;

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  const { fakeStripe: fake } = await import("./helpers/fake-stripe");
  return {
    ...actual,
    requireStripe: () => fake.client as never,
    sellableAddOns: () => [{ key: "reviews", name: "Review requests (add-on)", monthlyCents: 3500 }],
  };
});

const { getCart, checkCartPromo, beginCartCheckout } = await import("@/db/repositories/client/cart");

const BUILD = BUILDS[0]!;
const BUILD_PRODUCT = "prod_website_build";
const URLS = {
  successUrl: "https://portal.test/dashboard/billing?checkout=complete",
  cancelUrl: "https://portal.test/dashboard/cart?checkout=cancelled",
};

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

function stockStripe(): void {
  for (const build of BUILDS) addPrice(`build_${build.key}_v1`, build.priceCents, BUILD_PRODUCT, false);
  for (const plan of PLANS) addPrice(`${plan.key}_monthly_v2`, plan.monthlyCents, `prod_${plan.key}`);
  addPrice("addon_reviews_monthly_v1", 3500, "prod_reviews");
}

async function setClient(values: Partial<typeof clients.$inferInsert>): Promise<void> {
  await db.update(clients).set(values).where(eq(clients.id, acme.clientId));
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
  stockStripe();
  acme = await seedTenant(db, `Acme ${newPublicId()}`);
  await setClient({ buildKey: BUILD.key, primaryContactEmail: "owner@acme.test" });
});

describe("getCart", () => {
  it("offers the operator's build at its price, every published plan, and the add-ons on sale", async () => {
    const cart = await getCart(db, acme.ctx);

    expect(cart.open).toBe(true);
    if (!cart.open) return;
    expect(cart.catalog.build).toMatchObject({ key: BUILD.key, priceCents: BUILD.priceCents });
    expect(cart.catalog.plans.map((p) => p.key)).toEqual(PLANS.map((p) => p.key));
    expect(cart.catalog.addOns).toEqual([
      { key: "reviews", name: ADD_ON.name, summary: ADD_ON.summary, monthlyCents: 3500 },
    ]);
    const growth = cart.catalog.plans.find((p) => p.key === "growth")!;
    expect(growth.includes).toContain("reviews");
  });

  it("charges the price the operator quoted instead of the list price", async () => {
    await setClient({ buildPriceCents: 35000 });
    const cart = await getCart(db, acme.ctx);
    expect(cart.open && cart.catalog.build.priceCents).toBe(35000);
  });

  it("is closed for a complimentary client", async () => {
    const [comp] = await db.select({ id: servicePlans.id }).from(servicePlans).limit(1);
    await setClient({ compPlanId: comp!.id });
    expect(await getCart(db, acme.ctx)).toEqual({ open: false, reason: "complimentary" });
  });

  it("is closed for the agency's own site", async () => {
    await setClient({ isInternal: true });
    expect(await getCart(db, acme.ctx)).toEqual({ open: false, reason: "internal" });
  });

  it("is closed once the build is paid", async () => {
    await setClient({ buildPaidAt: new Date() });
    expect(await getCart(db, acme.ctx)).toEqual({ open: false, reason: "paid" });
  });

  it("is closed for a client who has already paid us anything, such as a deposit by Venmo", async () => {
    await db.insert(payments).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      amountCents: 25000,
      method: "venmo",
      receivedOn: "2026-10-01",
    });
    expect(await getCart(db, acme.ctx)).toEqual({ open: false, reason: "paid" });
  });

  it("is closed for a client already paying by card", async () => {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      monthlyPriceCents: 5000,
      startedOn: "2026-10-01",
      provider: "stripe",
      providerSubscriptionId: "sub_existing",
    });
    expect(await getCart(db, acme.ctx)).toEqual({ open: false, reason: "subscribed" });
  });

  it("is closed, waiting on the operator, when the build set is not in the catalogue", async () => {
    await setClient({ buildKey: "retired-build" });
    expect(await getCart(db, acme.ctx)).toEqual({ open: false, reason: "no_build" });
  });
});

describe("checkCartPromo", () => {
  it("shows the build after a code that only comes off the website", async () => {
    addCoupon({ id: "co_100", amount_off: 10000, applies_to: { products: [BUILD_PRODUCT] } });
    addPromo({ id: "promo_100", code: "WEB100", coupon: "co_100" });

    const result = await checkCartPromo(db, acme.ctx, "web100");

    expect(result).toEqual({
      ok: true,
      code: "WEB100",
      terms: "$100 off the website",
      buildDueCents: Math.max(0, BUILD.priceCents - 10000),
    });
  });

  it("refuses a code that would also come off the plan", async () => {
    addCoupon({ id: "co_half", percent_off: 50 });
    addPromo({ id: "promo_half", code: "HALF", coupon: "co_half" });

    const result = await checkCartPromo(db, acme.ctx, "HALF");

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/monthly payments/) });
  });
});

describe("beginCartCheckout", () => {
  it("charges the build, the plan and an add-on in one subscription checkout", async () => {
    addCoupon({ id: "co_100", amount_off: 10000, applies_to: { products: [BUILD_PRODUCT] } });
    addPromo({ id: "promo_100", code: "WEB100", coupon: "co_100" });

    const outcome = await beginCartCheckout(db, acme.ctx, {
      ...URLS,
      planKey: "care",
      addOnKeys: ["reviews"],
      promoCode: "WEB100",
    });

    expect(outcome).toMatchObject({ ok: true, reused: false });
    const { params } = fakeStripe.state.created[0]!;
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([
      { price: `price_build_${BUILD.key}_v1`, quantity: 1 },
      { price: "price_care_monthly_v2", quantity: 1 },
      { price: "price_addon_reviews_monthly_v1", quantity: 1 },
    ]);
    expect(params.discounts).toEqual([{ promotion_code: "promo_100" }]);
    // No code box on Stripe's page: a code typed there could discount the plan.
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.metadata).toMatchObject({
      checkout: "cart",
      client_id: acme.clientId,
      build_key: BUILD.key,
      build_product: BUILD_PRODUCT,
      plan_key: "care",
      add_ons: "reviews",
      promo_code_id: "promo_100",
    });
    expect(params.subscription_data?.metadata).toMatchObject({
      checkout: "cart",
      client_id: acme.clientId,
      plan_key: "care",
      build_product: BUILD_PRODUCT,
    });
  });

  it("takes a one-off payment when only the build is chosen", async () => {
    const outcome = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: null, addOnKeys: [], promoCode: "" });

    expect(outcome.ok).toBe(true);
    const { params } = fakeStripe.state.created[0]!;
    expect(params.mode).toBe("payment");
    expect(params.line_items).toEqual([{ price: `price_build_${BUILD.key}_v1`, quantity: 1 }]);
    expect(params.subscription_data).toBeUndefined();
    expect(params.payment_intent_data?.metadata).toMatchObject({ checkout: "cart", client_id: acme.clientId });
  });

  it("charges an operator's quoted price on the build product, so a build-only code still applies", async () => {
    await setClient({ buildPriceCents: 35000 });

    await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: null, addOnKeys: [], promoCode: "" });

    expect(fakeStripe.state.created[0]!.params.line_items).toEqual([
      { price_data: { currency: "usd", unit_amount: 35000, product: BUILD_PRODUCT }, quantity: 1 },
    ]);
  });

  it("drops an add-on the chosen plan already includes", async () => {
    await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "growth", addOnKeys: ["reviews"], promoCode: "" });

    expect(fakeStripe.state.created[0]!.params.line_items).toEqual([
      { price: `price_build_${BUILD.key}_v1`, quantity: 1 },
      { price: "price_growth_monthly_v2", quantity: 1 },
    ]);
  });

  it("refuses a plan the client was not offered, and creates nothing", async () => {
    const outcome = await beginCartCheckout(db, acme.ctx, {
      ...URLS,
      planKey: "comp-unlimited",
      addOnKeys: [],
      promoCode: "",
    });

    expect(outcome).toMatchObject({ ok: false, reason: "invalid_selection" });
    expect(fakeStripe.state.created).toEqual([]);
  });

  it("re-checks the code itself and refuses one that would discount the plan", async () => {
    addCoupon({ id: "co_half", percent_off: 50 });
    addPromo({ id: "promo_half", code: "HALF", coupon: "co_half" });

    const outcome = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "care", addOnKeys: [], promoCode: "HALF" });

    expect(outcome).toMatchObject({ ok: false, reason: "promo" });
    expect(fakeStripe.state.created).toEqual([]);
  });

  it("refuses when Stripe's price disagrees with the price on screen", async () => {
    addPrice("care_monthly_v2", 9900, "prod_care");

    const outcome = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "care", addOnKeys: [], promoCode: "" });

    expect(outcome).toMatchObject({ ok: false, reason: "price_mismatch" });
    expect(fakeStripe.state.created).toEqual([]);
  });

  it("refuses when the build has no Stripe price yet", async () => {
    fakeStripe.state.prices.delete(`build_${BUILD.key}_v1`);

    const outcome = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: null, addOnKeys: [], promoCode: "" });

    expect(outcome).toMatchObject({ ok: false, reason: "no_price" });
  });

  it("refuses a client who has paid", async () => {
    await setClient({ buildPaidAt: new Date() });

    const outcome = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: null, addOnKeys: [], promoCode: "" });

    expect(outcome).toMatchObject({ ok: false, reason: "paid" });
  });

  it("refuses a second subscription, checked against Stripe rather than the mirror", async () => {
    await setClient({ stripeCustomerId: "cus_acme" });
    addSubscription({ customer: "cus_acme", items: [{ lookupKey: "care_monthly_v2", unitAmount: 5000, periodEnd: 1_800_000_000 }] });

    const outcome = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "care", addOnKeys: [], promoCode: "" });

    expect(outcome).toMatchObject({ ok: false, reason: "already_subscribed" });
    expect(fakeStripe.state.created).toEqual([]);
  });

  it("sends a double click to the checkout it already opened", async () => {
    const input = { ...URLS, planKey: "care", addOnKeys: [], promoCode: "" };
    const first = await beginCartCheckout(db, acme.ctx, input);
    const second = await beginCartCheckout(db, acme.ctx, input);

    expect(second).toMatchObject({ ok: true, reused: true });
    expect(first.ok && second.ok && second.url).toBe(first.ok ? first.url : null);
    expect(fakeStripe.state.created).toHaveLength(1);
  });

  it("closes an older checkout for a different cart, so the client cannot pay for both", async () => {
    const first = await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "care", addOnKeys: [], promoCode: "" });
    await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "growth", addOnKeys: [], promoCode: "" });

    expect(fakeStripe.state.created).toHaveLength(2);
    const firstId = first.ok ? first.sessionId : "";
    expect(fakeStripe.state.expired).toEqual([firstId]);
  });

  it("starts the subscription on the operator's billing day", async () => {
    const [care] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, "care"));
    const today = new Date().getUTCDate();
    const billingDay = today === 15 ? 16 : 15;
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: acme.clientId,
      planId: care!.id,
      monthlyPriceCents: 5000,
      billingDay,
      startedOn: "2026-10-01",
    });

    await beginCartCheckout(db, acme.ctx, { ...URLS, planKey: "care", addOnKeys: [], promoCode: "" });

    expect(fakeStripe.state.created[0]!.params.subscription_data?.billing_cycle_anchor_config).toEqual({
      day_of_month: billingDay,
    });
  });
});
