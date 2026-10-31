import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { buildLinesOf, lineNetCents, lookupKeyForBuild, splitInvoice } from "@/lib/payments/build";

/**
 * Reading the build out of a subscription's first invoice.
 *
 * The ledger's two rows for that invoice, and whether the build is paid at
 * all, come from here — so every way the build's line can look, and every way
 * a line that is *not* the build can look like it, is pinned down.
 */

const BUILD_PRODUCT = "prod_website_build";
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function line(overrides: Record<string, unknown>): Stripe.InvoiceLineItem {
  return { amount: 0, discount_amounts: [], period: { start: 0, end: 0 }, ...overrides } as unknown as Stripe.InvoiceLineItem;
}

const BUILD_LINE = line({
  amount: 50000,
  parent: { type: "invoice_item_details" },
  pricing: { price_details: { price: "price_build", product: BUILD_PRODUCT } },
  // The instant it was bought: what `lines.data[0]` used to hand the plan.
  period: { start: at("2026-09-04T18:00:00Z"), end: at("2026-09-04T18:00:00Z") },
});

const PLAN_LINE = line({
  amount: 5000,
  parent: { type: "subscription_item_details" },
  pricing: { price_details: { price: "price_care", product: "prod_care" } },
  period: { start: at("2026-09-05T18:00:00Z"), end: at("2026-10-05T18:00:00Z") },
});

function invoice(overrides: Record<string, unknown>): Stripe.Invoice {
  return {
    billing_reason: "subscription_create",
    amount_paid: 55000,
    lines: { data: [BUILD_LINE, PLAN_LINE] },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

const META = { build_product: BUILD_PRODUCT };

describe("lookupKeyForBuild", () => {
  it("names the build's price the way the plans are named", () => {
    expect(lookupKeyForBuild()).toBe("build_website_v1");
    expect(lookupKeyForBuild("rush-job")).toBe("build_rush_job_v1");
  });
});

describe("splitInvoice", () => {
  it("splits a first invoice into the build and the plan, with the plan's own period", () => {
    expect(splitInvoice(invoice({}), META)).toEqual({
      buildCents: 50000,
      planCents: 5000,
      planPeriod: { start: "2026-09-05", end: "2026-10-05" },
    });
  });

  it("does not depend on the order Stripe lists the lines in", () => {
    const reversed = invoice({ lines: { data: [PLAN_LINE, BUILD_LINE] } });
    expect(splitInvoice(reversed, META)).toEqual(splitInvoice(invoice({}), META));
  });

  it("finds no build on a plan's own invoice", () => {
    const planOnly = invoice({ amount_paid: 5000, lines: { data: [PLAN_LINE] } });
    expect(splitInvoice(planOnly, META)).toEqual({
      buildCents: null,
      planCents: 5000,
      planPeriod: { start: "2026-09-05", end: "2026-10-05" },
    });
  });

  it("counts a build a 100%-off code took to zero as a build line of zero", () => {
    const free = line({ ...BUILD_LINE, discount_amounts: [{ amount: 50000, discount: "di_1" }] });
    const result = splitInvoice(invoice({ amount_paid: 5000, lines: { data: [free, PLAN_LINE] } }), META);
    expect(result).toMatchObject({ buildCents: 0, planCents: 5000 });
  });

  it("records the build after a partial code, never more than was collected", () => {
    const off = line({ ...BUILD_LINE, discount_amounts: [{ amount: 10000, discount: "di_1" }] });
    expect(splitInvoice(invoice({ amount_paid: 45000, lines: { data: [off, PLAN_LINE] } }), META)).toMatchObject({
      buildCents: 40000,
      planCents: 5000,
    });
    // Settled from credit: less arrived than the build's line.
    expect(splitInvoice(invoice({ amount_paid: 20000 }), META)).toMatchObject({ buildCents: 20000, planCents: 0 });
  });

  it("reads discounts from pretax_credit_amounts when the API puts them there", () => {
    const off = line({ ...BUILD_LINE, discount_amounts: undefined, pretax_credit_amounts: [{ amount: 50000, type: "discount" }] });
    expect(lineNetCents(off)).toBe(0);
  });
});

describe("buildLinesOf", () => {
  it("finds the build by its product", () => {
    expect(buildLinesOf(invoice({}), META)).toEqual([BUILD_LINE]);
  });

  it("falls back to the one-off line on a first invoice when the product is not recorded", () => {
    // A checkout made before the build was a product: no `build_product`.
    expect(buildLinesOf(invoice({}), {})).toEqual([BUILD_LINE]);
  });

  it("never takes a renewal's invoice item — a proration — for the build", () => {
    const proration = line({ amount: 1200, parent: { type: "invoice_item_details" } });
    const renewal = invoice({ billing_reason: "subscription_cycle", lines: { data: [proration, PLAN_LINE] } });
    expect(buildLinesOf(renewal, {})).toEqual([]);
    expect(splitInvoice(renewal, META).buildCents).toBeNull();
  });
});
