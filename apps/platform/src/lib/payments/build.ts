import type Stripe from "stripe";
import { BUILDS, type Build } from "@mortensenweb/plans";
import { requireStripe } from "./stripe";

/**
 * The website build, as Stripe sells it.
 *
 * Every build is a one-off price on **one** Stripe product, "Website build",
 * under the lookup key `build_<key>_v1` — the same lookup-key rule as the
 * plans (see `lib/payments/stripe.ts`), so the same code runs against the
 * sandbox and the live account. One product rather than one per build because
 * that product is what a build-only promo is restricted to: a coupon whose
 * `applies_to.products` is exactly this product can only ever come off the
 * website price, whichever build it is, and never off a plan.
 *
 * `npm run stripe:setup -- --apply` creates the product and the prices.
 */

export function lookupKeyForBuild(key: string): string {
  return `build_${key.replace(/-/g, "_")}_v1`;
}

export function allBuildLookupKeys(): string[] {
  return BUILDS.map((b) => lookupKeyForBuild(b.key));
}

/** The product a price belongs to, whether or not it was expanded. */
export function productIdOf(price: Pick<Stripe.Price, "product">): string {
  return typeof price.product === "string" ? price.product : price.product.id;
}

/** The live one-off price for a build. Looked up every time, like the plans. */
export async function priceForBuild(key: string): Promise<Stripe.Price | null> {
  const found = await requireStripe().prices.list({
    lookup_keys: [lookupKeyForBuild(key)],
    active: true,
    limit: 1,
  });
  return found.data[0] ?? null;
}

/**
 * The "Website build" product, read off whichever build price exists. Null
 * when none does yet — `stripe:setup` has not been run on this account.
 */
export async function buildProductId(): Promise<string | null> {
  const found = await requireStripe().prices.list({
    lookup_keys: allBuildLookupKeys(),
    active: true,
    limit: 10,
  });
  return found.data[0] ? productIdOf(found.data[0]) : null;
}

export interface ClientBuild {
  build: Build;
  /** What this client pays: the operator's quote, or the list price. */
  priceCents: number;
  /** True when the operator quoted a price other than the list price. */
  quoted: boolean;
}

/**
 * The build an operator set for a client, at the price they set.
 *
 * Unset means "the build" while there is only one, which is the catalogue
 * since 2026-10-21. With several and none chosen there is nothing to charge:
 * picking one for the client would let the cheapest be the default. A key
 * that is no longer in the catalogue is treated the same way.
 */
export function buildFor(client: { buildKey: string | null; buildPriceCents: number | null }): ClientBuild | null {
  const build = client.buildKey
    ? BUILDS.find((b) => b.key === client.buildKey)
    : BUILDS.length === 1
      ? BUILDS[0]
      : undefined;
  if (!build) return null;

  const quoted = client.buildPriceCents !== null && client.buildPriceCents !== build.priceCents;
  return { build, priceCents: client.buildPriceCents ?? build.priceCents, quoted };
}
