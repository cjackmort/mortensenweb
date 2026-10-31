import type Stripe from "stripe";
import { BUILD, BUILDS } from "@mortensenweb/plans";
import { businessDate } from "@/lib/billing/period";
import { requireStripe } from "./stripe";

/**
 * The website build, as Stripe sells it.
 *
 * Every build is a one-off price on **one** Stripe product, "Website build",
 * under the lookup key `build_<key>_v1` — the same lookup-key rule as the
 * plans (see `lib/payments/stripe.ts`), so the same code runs against the
 * sandbox and the live account. One product rather than one per build because
 * that product is what a build-only promo code is restricted to (roadmap
 * P1.4): a coupon whose `applies_to.products` is exactly this product can only
 * ever come off the website price, and never off a plan.
 *
 * `npm run stripe:setup -- --apply` creates the product and the price.
 */

export const BUILD_PRODUCT_NAME = "Website build";

export function lookupKeyForBuild(key: string = BUILD.key): string {
  return `build_${key.replace(/-/g, "_")}_v1`;
}

export function allBuildLookupKeys(): string[] {
  return BUILDS.map((b) => lookupKeyForBuild(b.key));
}

/** The product a price belongs to, whether or not it was expanded. */
export function productIdOf(price: Pick<Stripe.Price, "product">): string {
  return typeof price.product === "string" ? price.product : price.product.id;
}

/** The live one-off price for the build. Looked up every time, like the plans. */
export async function priceForBuild(key: string = BUILD.key): Promise<Stripe.Price | null> {
  const found = await requireStripe().prices.list({
    lookup_keys: [lookupKeyForBuild(key)],
    active: true,
    limit: 1,
  });
  return found.data[0] ?? null;
}

// ---------------------------------------------------------------------------
// Reading a settled invoice
// ---------------------------------------------------------------------------

/**
 * What a subscription's first invoice holds, split into the build and the
 * rest — the ledger's two rows for it.
 *
 * Checkout puts the build on the subscription's first invoice as a one-off
 * line beside the plan and any add-ons. Recording that invoice as one row
 * booked $500 of build as subscription revenue and left nothing to say the
 * build had been paid, so `applyPaidInvoice` records each part on its own.
 */
export interface InvoiceSplit {
  /** The build's share of what was collected; null when the invoice has no build line. */
  buildCents: number | null;
  /** Everything else that was collected: the plan and add-ons. */
  planCents: number;
  /** The month the plan line covers, in the business timezone. Null with no subscription line. */
  planPeriod: { start: string; end: string } | null;
}

function productOf(line: Stripe.InvoiceLineItem): string | null {
  return line.pricing?.price_details?.product ?? null;
}

/**
 * A line's amount after its discounts — what the client was actually charged
 * for it. `pretax_credit_amounts` is where newer API versions put discounts;
 * `discount_amounts` is read when it is absent.
 */
export function lineNetCents(line: Stripe.InvoiceLineItem): number {
  const credits = (line as Stripe.InvoiceLineItem & {
    pretax_credit_amounts?: Array<{ amount: number; type?: string }> | null;
  }).pretax_credit_amounts;
  const discounts = credits?.length
    ? credits.filter((c) => c.type === undefined || c.type === "discount")
    : (line.discount_amounts ?? []);
  const off = discounts.reduce((sum, d) => sum + d.amount, 0);
  return Math.max(0, line.amount - off);
}

/**
 * The build's lines on an invoice.
 *
 * By the build product, which the welcome checkout writes into the
 * subscription's metadata as `build_product` — exact, and needs no call to
 * Stripe. Failing that, on a subscription's *first* invoice, a line that came
 * from an invoice item rather than a subscription item: the only one-off line
 * a checkout in this portal puts there is the build. Never on a renewal,
 * where an invoice item is a proration.
 */
export function buildLinesOf(
  invoice: Stripe.Invoice,
  metadata: Stripe.Metadata | null,
): Stripe.InvoiceLineItem[] {
  const lines = invoice.lines?.data ?? [];
  const product = metadata?.build_product || null;
  if (product) {
    const byProduct = lines.filter((line) => productOf(line) === product);
    if (byProduct.length > 0) return byProduct;
  }
  if (invoice.billing_reason !== "subscription_create") return [];
  return lines.filter((line) => line.parent?.type === "invoice_item_details");
}

/**
 * The line whose period the plan payment covers.
 *
 * A subscription item's line, never `lines.data[0]`: Stripe does not promise
 * an order, and on a first invoice the first line can be the build, whose
 * period is the instant it was bought.
 */
export function subscriptionLineOf(
  invoice: Stripe.Invoice,
  exclude: readonly Stripe.InvoiceLineItem[] = [],
): Stripe.InvoiceLineItem | null {
  const lines = (invoice.lines?.data ?? []).filter((line) => !exclude.includes(line));
  return (
    lines.find((line) => line.parent?.type === "subscription_item_details") ??
    // A payload without `parent` (older API versions, hand-built fixtures):
    // anything that is not the build.
    lines.find((line) => !line.parent) ??
    null
  );
}

function day(seconds: number | undefined): string | null {
  return seconds ? businessDate(new Date(seconds * 1000)) : null;
}

export function splitInvoice(invoice: Stripe.Invoice, metadata: Stripe.Metadata | null): InvoiceSplit {
  const collected = invoice.amount_paid ?? 0;
  const build = buildLinesOf(invoice, metadata);
  // Never more than was collected: credit or a whole-invoice discount can
  // leave less than the build's own line, and the ledger records money.
  const buildCents =
    build.length > 0 ? Math.min(collected, build.reduce((sum, line) => sum + lineNetCents(line), 0)) : null;

  const line = subscriptionLineOf(invoice, build);
  const start = day(line?.period?.start);
  const end = day(line?.period?.end);

  return {
    buildCents,
    planCents: collected - (buildCents ?? 0),
    planPeriod: start && end ? { start, end } : null,
  };
}
