import { describe, expect, it } from "vitest";
import { BUILD, GROWTH_FEATURES, PLANS } from "@mortensenweb/plans";
import {
  addOnOptions,
  basketSignature,
  buildWelcomeBasket,
  cheaperPlanFor,
  stripeLineItems,
  type OfferedPlan,
  type SiteDue,
} from "@/lib/onboarding/checkout";

/**
 * The welcome checkout's basket: what a new client is asked to pay on their
 * first visit. Pure, and shared by the page (the total they see) and the
 * server (the lines Stripe is asked to charge), so these tests pin the one
 * place both come from.
 */

const OFFERED: OfferedPlan[] = PLANS.map((p) => ({ key: p.key, name: p.name, monthlyCents: p.monthlyCents }));
const BUILD_DUE: SiteDue = { kind: "build", amountCents: BUILD.priceCents };
const PAID: SiteDue = { kind: "none", reason: "paid" };
const INVOICE_DUE: SiteDue = {
  kind: "invoice",
  publicId: "REQ1",
  reference: "MW-7F3K",
  amountCents: 42_000,
  currency: "USD",
  note: "Website build",
  dueOn: "2026-10-29",
  status: "open",
  others: 0,
};

const price = (cents: number) => PLANS.find((p) => p.monthlyCents === cents)!;
const feature = (key: string) => GROWTH_FEATURES.find((f) => f.key === key)!;

function basketOf(input: Parameters<typeof buildWelcomeBasket>[0]) {
  const result = buildWelcomeBasket(input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.basket;
}

describe("buildWelcomeBasket", () => {
  it("charges the published build price alone, as one payment, when no plan is chosen", () => {
    const basket = basketOf({ siteDue: BUILD_DUE, plans: OFFERED, planKey: null, addOns: [] });

    expect(basket).not.toBeNull();
    expect(basket!.mode).toBe("payment");
    expect(basket!.lines).toEqual([
      { kind: "build", key: "build", name: "Website build", amountCents: BUILD.priceCents, recurring: false },
    ]);
    expect(basket!.dueTodayCents).toBe(BUILD.priceCents);
    expect(basket!.monthlyCents).toBe(0);
  });

  it("puts the build on the first payment of a subscription when a plan is chosen", () => {
    const care = PLANS.find((p) => p.key === "care")!;
    const basket = basketOf({ siteDue: BUILD_DUE, plans: OFFERED, planKey: "care", addOns: [] })!;

    expect(basket.mode).toBe("subscription");
    expect(basket.lines.map((l) => [l.kind, l.key, l.recurring])).toEqual([
      ["plan", "care", true],
      ["build", "build", false],
    ]);
    expect(basket.dueTodayCents).toBe(BUILD.priceCents + care.monthlyCents);
    expect(basket.monthlyCents).toBe(care.monthlyCents);
  });

  it("adds each chosen add-on at its own price from the plans package", () => {
    const lite = price(2500);
    const basket = basketOf({ siteDue: PAID, plans: OFFERED, planKey: "lite", addOns: ["reviews", "winback"] })!;

    const addOnLines = basket.lines.filter((l) => l.kind === "add-on");
    expect(addOnLines.map((l) => [l.key, l.amountCents])).toEqual([
      ["reviews", feature("reviews").addOnCents],
      ["winback", feature("winback").addOnCents],
    ]);
    expect(basket.monthlyCents).toBe(lite.monthlyCents + feature("reviews").addOnCents + feature("winback").addOnCents);
    expect(basket.dueTodayCents).toBe(basket.monthlyCents);
    expect(basket.includesBuild).toBe(false);
  });

  it("drops an add-on the chosen plan already includes rather than charging for it twice", () => {
    const basket = basketOf({ siteDue: PAID, plans: OFFERED, planKey: "growth", addOns: ["reviews", "showcase"] })!;

    expect(basket.addOns).toEqual(["showcase"]);
    expect(basket.lines.some((l) => l.key === "reviews")).toBe(false);
  });

  it("drops free features, which every client already has", () => {
    const basket = basketOf({ siteDue: PAID, plans: OFFERED, planKey: "care", addOns: ["leads", "search"] })!;

    expect(basket.addOns).toEqual([]);
    expect(basket.lines.map((l) => l.kind)).toEqual(["plan"]);
  });

  it("counts a repeated add-on once", () => {
    const basket = basketOf({ siteDue: PAID, plans: OFFERED, planKey: "lite", addOns: ["reviews", "reviews"] })!;

    expect(basket.addOns).toEqual(["reviews"]);
  });

  it("refuses add-ons without a plan, because they are sold on top of one", () => {
    const result = buildWelcomeBasket({ siteDue: BUILD_DUE, plans: OFFERED, planKey: null, addOns: ["reviews"] });

    expect(result).toMatchObject({ ok: false, reason: "add_on_needs_plan" });
  });

  it("refuses a plan that is not offered to this client", () => {
    const offeredWithoutPro = OFFERED.filter((p) => p.key !== "pro");
    const result = buildWelcomeBasket({ siteDue: PAID, plans: offeredWithoutPro, planKey: "pro", addOns: [] });

    expect(result).toMatchObject({ ok: false, reason: "unknown_plan" });
  });

  it("refuses an add-on that does not exist", () => {
    const result = buildWelcomeBasket({ siteDue: PAID, plans: OFFERED, planKey: "lite", addOns: ["free-money"] });

    expect(result).toMatchObject({ ok: false, reason: "unknown_add_on" });
  });

  it("refuses a feature that is not built yet, so nobody pays for a button that does nothing", () => {
    const unbuiltPaid = GROWTH_FEATURES.find((f) => !f.available && f.includedFrom !== "free");
    // Every unbuilt feature may be free today; the rule still has to hold for
    // the next one, so check it through the option list as well.
    const options = addOnOptions("lite");
    for (const option of options.filter((o) => !o.feature.available)) {
      expect(option.state.kind).toBe("coming_soon");
    }
    if (unbuiltPaid) {
      const result = buildWelcomeBasket({ siteDue: PAID, plans: OFFERED, planKey: "lite", addOns: [unbuiltPaid.key] });
      expect(result).toMatchObject({ ok: false, reason: "add_on_unavailable" });
    }
  });

  it("returns nothing to pay when the site is paid for and nothing is chosen", () => {
    expect(buildWelcomeBasket({ siteDue: PAID, plans: OFFERED, planKey: null, addOns: [] })).toEqual({
      ok: true,
      basket: null,
    });
  });

  it("never folds an invoice we raised into the basket: it is paid on its own", () => {
    expect(buildWelcomeBasket({ siteDue: INVOICE_DUE, plans: OFFERED, planKey: null, addOns: [] })).toEqual({
      ok: true,
      basket: null,
    });

    const basket = basketOf({ siteDue: INVOICE_DUE, plans: OFFERED, planKey: "care", addOns: [] })!;
    expect(basket.lines.map((l) => l.kind)).toEqual(["plan"]);
    expect(basket.includesBuild).toBe(false);
  });

  it("treats a plan the package does not know (the test plan) as including nothing", () => {
    const withTest = [...OFFERED, { key: "test-plan", name: "Test plan", monthlyCents: 100 }];
    const basket = basketOf({ siteDue: PAID, plans: withTest, planKey: "test-plan", addOns: ["reviews"] })!;

    expect(basket.lines.map((l) => [l.key, l.amountCents])).toEqual([
      ["test-plan", 100],
      ["reviews", feature("reviews").addOnCents],
    ]);
  });
});

describe("addOnOptions", () => {
  it("marks paid add-ons as needing a plan until one is chosen", () => {
    const reviews = addOnOptions(null).find((o) => o.feature.key === "reviews")!;
    expect(reviews.state).toEqual({ kind: "needs_plan", monthlyCents: feature("reviews").addOnCents });
  });

  it("marks what the chosen plan includes, naming the plan", () => {
    const reviews = addOnOptions("growth").find((o) => o.feature.key === "reviews")!;
    expect(reviews.state).toEqual({ kind: "included", planName: "Growth" });
  });

  it("marks built free features as free whatever the plan", () => {
    const leads = addOnOptions(null).find((o) => o.feature.key === "leads")!;
    expect(leads.state).toEqual({ kind: "free" });
  });

  it("lists every Growth feature exactly once", () => {
    const keys = addOnOptions("care").map((o) => o.feature.key);
    expect([...keys].sort()).toEqual(GROWTH_FEATURES.map((f) => f.key).sort());
  });
});

describe("cheaperPlanFor", () => {
  it("suggests the higher plan when it costs less than the plan plus the add-ons", () => {
    // Care $50 + reviews $35 + campaigns $20 = $105; Growth includes both for $100.
    const suggestion = cheaperPlanFor("care", ["reviews", "campaigns"], OFFERED);

    expect(suggestion).toEqual({ planKey: "growth", planName: "Growth", savesCents: 500 });
  });

  it("stays quiet when the add-ons are the cheaper route", () => {
    expect(cheaperPlanFor("care", ["campaigns"], OFFERED)).toBeNull();
  });

  it("stays quiet without add-ons or without a plan", () => {
    expect(cheaperPlanFor("care", [], OFFERED)).toBeNull();
    expect(cheaperPlanFor(null, ["reviews"], OFFERED)).toBeNull();
  });

  it("only suggests a plan this client is offered", () => {
    const withoutGrowth = OFFERED.filter((p) => p.key !== "growth");
    expect(cheaperPlanFor("care", ["reviews", "campaigns"], withoutGrowth)).toBeNull();
  });
});

describe("stripeLineItems", () => {
  it("sends every line by price id, the build as the Website build product's price", () => {
    const basket = basketOf({ siteDue: BUILD_DUE, plans: OFFERED, planKey: "lite", addOns: ["reviews"] })!;

    const result = stripeLineItems(basket, {
      plan: { id: "price_lite" },
      addOns: { reviews: { id: "price_reviews" } },
      build: { id: "price_build" },
    });

    expect(result).toEqual({
      ok: true,
      items: [
        { price: "price_lite", quantity: 1 },
        { price: "price_reviews", quantity: 1 },
        { price: "price_build", quantity: 1 },
      ],
    });
  });

  it("refuses rather than leaving out a line whose Stripe price is missing", () => {
    const basket = basketOf({ siteDue: PAID, plans: OFFERED, planKey: "lite", addOns: ["reviews"] })!;

    expect(stripeLineItems(basket, { plan: { id: "price_lite" }, addOns: {}, build: null })).toEqual({
      ok: false,
      missing: "Review requests",
    });
    expect(stripeLineItems(basket, { plan: null, addOns: { reviews: { id: "x" } }, build: null })).toEqual({
      ok: false,
      missing: "Lite plan",
    });
  });

  it("refuses a basket with the build when the build has no Stripe price", () => {
    // `stripe:setup --apply` not yet run on this account. Charging the build
    // as a bare amount would put it beyond a build-only promo code and the
    // receiver's line matching, so the checkout waits for the price.
    const basket = basketOf({ siteDue: BUILD_DUE, plans: OFFERED, planKey: "lite", addOns: [] })!;
    expect(stripeLineItems(basket, { plan: { id: "price_lite" }, addOns: {}, build: null })).toEqual({
      ok: false,
      missing: "Website build",
    });
  });
});

describe("basketSignature", () => {
  it("is the same for the same choice in any order, and differs when the choice does", () => {
    const a = basketOf({ siteDue: BUILD_DUE, plans: OFFERED, planKey: "lite", addOns: ["winback", "reviews"] })!;
    const b = basketOf({ siteDue: BUILD_DUE, plans: OFFERED, planKey: "lite", addOns: ["reviews", "winback"] })!;
    const c = basketOf({ siteDue: PAID, plans: OFFERED, planKey: "lite", addOns: ["reviews", "winback"] })!;

    expect(basketSignature(a)).toBe(basketSignature(b));
    expect(basketSignature(a)).not.toBe(basketSignature(c));
    expect(basketSignature(a).length).toBeLessThan(200);
  });
});
