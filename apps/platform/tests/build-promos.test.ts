import { beforeEach, describe, expect, it, vi } from "vitest";
import { addCoupon, addPromo, fakeStripe, resetFakeStripe } from "./helpers/fake-stripe";

/**
 * Promo codes that come off the website price and nothing else.
 *
 * The operator hands out codes in conversation and changes them around. The
 * failures worth testing are the ones that cost money without anybody
 * noticing: a code that quietly discounts every monthly payment for ever, a
 * code that has run out still being honoured, and a Stripe outage being read
 * as "the code is fine".
 */

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  const { fakeStripe: fake } = await import("./helpers/fake-stripe");
  return { ...actual, requireStripe: () => fake.client as never };
});

const { checkBuildPromo, createBuildPromo, listBuildPromos, deactivateBuildPromo } = await import(
  "@/lib/payments/build-promos"
);

const BUILD = "prod_build";
const PLAN = "prod_care";

beforeEach(() => {
  resetFakeStripe();
});

function buildOnly(id: string, terms: { percent_off?: number; amount_off?: number }) {
  return addCoupon({ id, ...terms, percent_off: terms.percent_off ?? null, amount_off: terms.amount_off ?? null, applies_to: { products: [BUILD] } });
}

describe("checkBuildPromo", () => {
  it("accepts a code that only comes off the build, whatever case it is typed in", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_1", code: "WELCOME100", coupon: "co_100" });

    const result = await checkBuildPromo(" welcome100 ", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({
      ok: true,
      promo: { id: "promo_1", code: "WELCOME100", terms: "$100 off the website" },
      buildDueCents: 40000,
    });
  });

  it("works out a percentage off the build", async () => {
    buildOnly("co_25", { percent_off: 25 });
    addPromo({ id: "promo_1", code: "QUARTER", coupon: "co_25" });

    const result = await checkBuildPromo("QUARTER", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: true, buildDueCents: 37500, promo: { terms: "25% off the website" } });
  });

  it("refuses a code that would also come off the monthly payments", async () => {
    addCoupon({ id: "co_all", percent_off: 50 });
    addPromo({ id: "promo_all", code: "HALF", coupon: "co_all" });

    const result = await checkBuildPromo("HALF", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "not_build_only" });
    expect(result.ok ? "" : result.message).toMatch(/monthly/);
  });

  it("refuses a code restricted to the build and a plan together", async () => {
    addCoupon({ id: "co_both", amount_off: 5000, applies_to: { products: [BUILD, PLAN] } });
    addPromo({ id: "promo_both", code: "BOTH", coupon: "co_both" });

    const result = await checkBuildPromo("BOTH", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "not_build_only" });
  });

  it("refuses a code restricted to a plan only", async () => {
    addCoupon({ id: "co_plan", amount_off: 5000, applies_to: { products: [PLAN] } });
    addPromo({ id: "promo_plan", code: "PLANONLY", coupon: "co_plan" });

    const result = await checkBuildPromo("PLANONLY", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "not_build_only" });
  });

  it("refuses a code nobody made", async () => {
    const result = await checkBuildPromo("NOPE", { buildProductId: BUILD, buildCents: 50000, customerId: null });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses an empty code without asking Stripe", async () => {
    const result = await checkBuildPromo("   ", { buildProductId: BUILD, buildCents: 50000, customerId: null });
    expect(result).toMatchObject({ ok: false, reason: "empty" });
    expect(fakeStripe.state.calls).toEqual([]);
  });

  it("refuses an expired code", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_old", code: "SUMMER", coupon: "co_100", expires_at: Math.floor(Date.now() / 1000) - 60 });

    const result = await checkBuildPromo("SUMMER", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a deactivated code", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_off", code: "OFF", coupon: "co_100", active: false });

    const result = await checkBuildPromo("OFF", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a code that has been used up", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_used", code: "FIRST5", coupon: "co_100", max_redemptions: 5, times_redeemed: 5 });

    const result = await checkBuildPromo("FIRST5", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "used_up" });
  });

  it("refuses a code made for a different customer", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_theirs", code: "JUSTYOU", coupon: "co_100", customer: "cus_other" });

    const result = await checkBuildPromo("JUSTYOU", { buildProductId: BUILD, buildCents: 50000, customerId: "cus_mine" });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses a code whose minimum spend the build does not reach", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({
      id: "promo_min",
      code: "BIGJOB",
      coupon: "co_100",
      restrictions: { first_time_transaction: false, minimum_amount: 100000 },
    });

    const result = await checkBuildPromo("BIGJOB", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "not_applicable" });
  });

  it("never takes more than the build price off", async () => {
    buildOnly("co_big", { amount_off: 90000 });
    addPromo({ id: "promo_big", code: "FREE", coupon: "co_big" });

    const result = await checkBuildPromo("FREE", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: true, buildDueCents: 0 });
  });

  it("says it could not check, and applies nothing, when Stripe is down", async () => {
    fakeStripe.state.outage = Object.assign(new Error("connect ECONNREFUSED"), { type: "StripeConnectionError" });

    const result = await checkBuildPromo("WELCOME100", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("createBuildPromo", () => {
  it("makes a one-off coupon restricted to the build product, and a code for it", async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);

    const result = await createBuildPromo(
      { code: "spring-100", kind: "amount", value: 10000, expiresAt, maxRedemptions: 10 },
      { buildProductId: BUILD },
    );

    expect(result).toMatchObject({ ok: true, code: "SPRING-100" });
    const coupon = [...fakeStripe.state.coupons.values()][0]!;
    expect(coupon).toMatchObject({ amount_off: 10000, currency: "usd", duration: "once", applies_to: { products: [BUILD] } });
    const promo = [...fakeStripe.state.promos.values()][0]!;
    expect(promo).toMatchObject({
      code: "SPRING-100",
      max_redemptions: 10,
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      promotion: { coupon: coupon.id },
    });
  });

  it("is checked by checkBuildPromo as build-only", async () => {
    await createBuildPromo({ code: "QUARTER", kind: "percent", value: 25 }, { buildProductId: BUILD });

    const result = await checkBuildPromo("quarter", { buildProductId: BUILD, buildCents: 50000, customerId: null });

    expect(result).toMatchObject({ ok: true, buildDueCents: 37500 });
  });

  it.each([
    [{ code: "no spaces", kind: "amount" as const, value: 100 }, /letters, numbers and dashes/],
    [{ code: "OK", kind: "amount" as const, value: 100 }, /letters, numbers and dashes/],
    [{ code: "PCT", kind: "percent" as const, value: 0 }, /between 1 and 100/],
    [{ code: "PCT", kind: "percent" as const, value: 101 }, /between 1 and 100/],
    [{ code: "AMT", kind: "amount" as const, value: 0 }, /more than \$0/],
    [{ code: "CAP", kind: "amount" as const, value: 100, maxRedemptions: 0 }, /at least once/],
    [{ code: "PAST", kind: "amount" as const, value: 100, expiresAt: new Date(Date.now() - 1000) }, /future/],
  ])("refuses %o before calling Stripe", async (input, message) => {
    const result = await createBuildPromo(input, { buildProductId: BUILD });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(message);
    expect(fakeStripe.state.calls).toEqual([]);
  });

  it("says so when the code is already in use", async () => {
    await createBuildPromo({ code: "TAKEN", kind: "amount", value: 100 }, { buildProductId: BUILD });
    const again = await createBuildPromo({ code: "taken", kind: "amount", value: 200 }, { buildProductId: BUILD });
    expect(again).toMatchObject({ ok: false });
    expect(again.ok ? "" : again.message).toMatch(/already/);
  });
});

describe("listBuildPromos and deactivateBuildPromo", () => {
  it("lists active codes, marking which ones work on the website price", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_build", code: "WEB100", coupon: "co_100" });
    addCoupon({ id: "co_all", percent_off: 50 });
    addPromo({ id: "promo_all", code: "HALF", coupon: "co_all" });

    const list = await listBuildPromos({ buildProductId: BUILD });

    expect(list.map((p) => [p.code, p.buildOnly, p.terms])).toEqual(
      expect.arrayContaining([
        ["WEB100", true, "$100 off the website"],
        ["HALF", false, "50% off the first payment"],
      ]),
    );
  });

  it("switches a code off", async () => {
    buildOnly("co_100", { amount_off: 10000 });
    addPromo({ id: "promo_build", code: "WEB100", coupon: "co_100" });

    await deactivateBuildPromo("promo_build");

    expect(fakeStripe.state.promos.get("promo_build")?.active).toBe(false);
    const result = await checkBuildPromo("WEB100", { buildProductId: BUILD, buildCents: 50000, customerId: null });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });
});
