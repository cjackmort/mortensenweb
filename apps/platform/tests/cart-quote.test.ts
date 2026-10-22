import { describe, expect, it } from "vitest";
import {
  firstPeriodCents,
  nextAnchorDate,
  quoteCart,
  selectionFrom,
  type CartCatalog,
} from "@/lib/billing/cart";

/**
 * The cart's arithmetic: what is due today and what is charged after.
 *
 * Pure, so the browser shows the same figures the server charges. The
 * failures worth testing are the ones that show one number and charge
 * another: an add-on the chosen plan already includes being billed twice,
 * a plan or add-on the client was never offered getting through, and the
 * first payment on an operator's billing day not matching Stripe's proration.
 */

const catalog: CartCatalog = {
  build: { key: "website", name: "Website", includes: ["A site"], priceCents: 50000 },
  plans: [
    { key: "care", name: "Care", short: "Care", monthlyCents: 5000, description: "", features: [], includes: ["leads"], recommended: false, featured: true },
    { key: "growth", name: "Growth", short: "Growth", monthlyCents: 10000, description: "", features: [], includes: ["leads", "reviews"], recommended: false, featured: false },
  ],
  addOns: [
    { key: "leads", name: "Leads inbox", summary: "", monthlyCents: 1500 },
    { key: "reviews", name: "Review requests", summary: "", monthlyCents: 3500 },
  ],
  anchorDay: null,
};

describe("selectionFrom", () => {
  it("accepts no plan and no add-ons: the build on its own", () => {
    expect(selectionFrom(catalog, { planKey: "", addOnKeys: [] })).toEqual({
      ok: true,
      selection: { planKey: null, addOnKeys: [] },
    });
  });

  it("refuses a plan the client was not offered", () => {
    const result = selectionFrom(catalog, { planKey: "pro", addOnKeys: [] });
    expect(result.ok).toBe(false);
  });

  it("refuses an add-on that is not on sale", () => {
    const result = selectionFrom(catalog, { planKey: "care", addOnKeys: ["showcase"] });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/isn't available/) });
  });

  it("refuses add-ons without a plan to go on top of", () => {
    const result = selectionFrom(catalog, { planKey: null, addOnKeys: ["reviews"] });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/Choose a plan/) });
  });

  it("drops an add-on the chosen plan already includes, so it is never billed twice", () => {
    expect(selectionFrom(catalog, { planKey: "growth", addOnKeys: ["reviews", "leads"] })).toEqual({
      ok: true,
      selection: { planKey: "growth", addOnKeys: [] },
    });
  });

  it("removes duplicate add-ons", () => {
    expect(selectionFrom(catalog, { planKey: "care", addOnKeys: ["reviews", "reviews"] })).toEqual({
      ok: true,
      selection: { planKey: "care", addOnKeys: ["reviews"] },
    });
  });
});

describe("quoteCart", () => {
  const now = new Date("2026-10-21T15:00:00Z");

  it("charges the build alone when nothing recurring is chosen", () => {
    const quote = quoteCart(catalog, { planKey: null, addOnKeys: [] }, 50000, now);
    expect(quote.dueTodayCents).toBe(50000);
    expect(quote.monthlyCents).toBe(0);
    expect(quote.renewsOn).toBeNull();
    expect(quote.lines.map((l) => l.kind)).toEqual(["build"]);
  });

  it("adds the first month of the plan and add-ons to today's payment", () => {
    const quote = quoteCart(catalog, { planKey: "care", addOnKeys: ["reviews"] }, 40000, now);
    expect(quote.monthlyCents).toBe(8500);
    expect(quote.firstPeriodCents).toBe(8500);
    expect(quote.dueTodayCents).toBe(48500);
    expect(quote.renewsOn?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
    expect(quote.lines.map((l) => [l.kind, l.key])).toEqual([
      ["build", "website"],
      ["plan", "care"],
      ["add-on", "reviews"],
    ]);
  });

  it("shows the build at its list price and at the discounted price", () => {
    const quote = quoteCart(catalog, { planKey: null, addOnKeys: [] }, 40000, now);
    expect(quote.lines[0]).toMatchObject({ kind: "build", listCents: 50000, cents: 40000 });
  });

  it("prorates the first month to the operator's billing day", () => {
    const quote = quoteCart({ ...catalog, anchorDay: 1 }, { planKey: "care", addOnKeys: [] }, 50000, now);
    // 21 Oct 15:00 to 1 Nov 15:00 is 11 of October's 31 days.
    expect(quote.renewsOn?.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(quote.firstPeriodCents).toBe(Math.round((5000 * 11) / 31));
    expect(quote.prorated).toBe(true);
  });
});

describe("nextAnchorDate", () => {
  it("lands later this month when the day is still ahead", () => {
    expect(nextAnchorDate(new Date("2026-10-21T15:00:00Z"), 25).toISOString()).toBe("2026-10-25T15:00:00.000Z");
  });

  it("lands next month when the day has passed", () => {
    expect(nextAnchorDate(new Date("2026-10-21T15:00:00Z"), 5).toISOString()).toBe("2026-11-05T15:00:00.000Z");
  });

  it("crosses the year", () => {
    expect(nextAnchorDate(new Date("2026-12-20T15:00:00Z"), 3).toISOString()).toBe("2027-01-03T15:00:00.000Z");
  });
});

describe("firstPeriodCents", () => {
  it("is the full price without an anchor", () => {
    expect(firstPeriodCents([5000, 3500], new Date(), null)).toBe(8500);
  });

  it("rounds each line on its own, as Stripe prorates per item", () => {
    const now = new Date("2026-10-21T15:00:00Z");
    const end = nextAnchorDate(now, 1);
    expect(firstPeriodCents([5000, 3500], now, end)).toBe(
      Math.round((5000 * 11) / 31) + Math.round((3500 * 11) / 31),
    );
  });
});
