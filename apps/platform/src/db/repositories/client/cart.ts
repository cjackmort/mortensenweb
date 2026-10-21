import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import type Stripe from "stripe";
import { GROWTH_FEATURES, PLANS } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { clients, organizations, payments, subscriptions } from "@/db/schema";
import { anchorDayFor } from "@/lib/billing/billing-day";
import { quoteCart, selectionFrom, type CartCatalog, type CartSelection } from "@/lib/billing/cart";
import { buildFor, lookupKeyForBuild, productIdOf } from "@/lib/payments/build";
import { checkBuildPromo, type BuildPromo } from "@/lib/payments/build-promos";
import {
  expectedCentsForPlan,
  lookupKeyForAddOn,
  lookupKeyForPlan,
  requireStripe,
  sellableAddOns,
  stripeConfigured,
  type SellableKey,
} from "@/lib/payments/stripe";
import type { TenantContext } from "../context";
import { offeredPlans } from "./plan-choice";
import { ensureCustomer, liveSubscription, type ResolvedClient } from "./stripe-checkout";

/**
 * The cart a new client pays from, once they have set their password.
 *
 * One page and one payment: the website build the operator set for them, an
 * optional plan, and optional Growth add-ons on top of it. With anything
 * recurring chosen, Stripe Checkout runs in `subscription` mode and bills the
 * build as a one-off line on the first invoice; with the build alone it is a
 * plain `payment`. Either way the client pays once.
 *
 * ## What the browser decides
 *
 * Which plan, which add-ons, and a promo code as typed — keys and a string,
 * nothing else. The build is the one on the client's record, so a cheaper one
 * cannot be chosen. Every price is resolved here by lookup key, checked
 * against the price the page showed, and refused when they disagree: the
 * total on screen is the total charged, or nothing is charged.
 *
 * ## The guarantees kept from the plan picker
 *
 * No checkout for a complimentary client, and no second subscription — the
 * latter checked against Stripe, not the mirror, because the mirror can lag
 * a completed checkout by exactly the seconds that matter. Added here: a
 * client who has paid anything is not asked to pay for their website again.
 */

export type CartClosedReason =
  | "not_configured"
  | "no_client"
  | "complimentary"
  | "internal"
  | "paid"
  | "subscribed"
  | "no_build";

export type CartState =
  | {
      open: true;
      catalog: CartCatalog;
      /** A promo the operator attached, when it only comes off the build. */
      attachedPromo: { code: string; terms: string; buildDueCents: number } | null;
    }
  | { open: false; reason: CartClosedReason };

interface CartClient extends ResolvedClient {
  isInternal: boolean;
  buildKey: string | null;
  buildPriceCents: number | null;
  buildPaidAt: Date | null;
}

async function loadClient(db: Database, ctx: TenantContext): Promise<CartClient | null> {
  const rows = await db
    .select({
      clientId: clients.id,
      publicId: clients.publicId,
      businessName: organizations.name,
      contactEmail: clients.primaryContactEmail,
      stripeCustomerId: clients.stripeCustomerId,
      compPlanId: clients.compPlanId,
      promoCodeId: clients.promoCodeId,
      isInternal: clients.isInternal,
      buildKey: clients.buildKey,
      buildPriceCents: clients.buildPriceCents,
      buildPaidAt: clients.buildPaidAt,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  return rows[0] ?? null;
}

/** Any money recorded from this client: a deposit by Venmo counts as paid. */
async function hasPaid(db: Database, client: CartClient): Promise<boolean> {
  if (client.buildPaidAt) return true;
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.clientId, client.clientId), eq(payments.status, "recorded"), gt(payments.amountCents, 0)))
    .limit(1);
  return rows.length > 0;
}

async function billedByProcessor(db: Database, clientId: string): Promise<boolean> {
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.clientId, clientId), eq(subscriptions.status, "active"), isNotNull(subscriptions.provider)),
    )
    .limit(1);
  return rows.length > 0;
}

interface Opened {
  client: CartClient;
  catalog: CartCatalog;
}

async function openCart(db: Database, ctx: TenantContext): Promise<Opened | { reason: CartClosedReason }> {
  if (!stripeConfigured()) return { reason: "not_configured" };
  const client = await loadClient(db, ctx);
  if (!client) return { reason: "no_client" };
  if (client.compPlanId) return { reason: "complimentary" };
  if (client.isInternal) return { reason: "internal" };
  if (await hasPaid(db, client)) return { reason: "paid" };
  if (await billedByProcessor(db, client.clientId)) return { reason: "subscribed" };

  const chosen = buildFor(client);
  if (!chosen) return { reason: "no_build" };

  const { plans, assigned } = await offeredPlans(db, client.clientId);
  const catalog: CartCatalog = {
    build: {
      key: chosen.build.key,
      name: chosen.build.name,
      includes: chosen.build.includes,
      priceCents: chosen.priceCents,
    },
    plans: plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      short: plan.short,
      monthlyCents: plan.monthlyCents,
      description: plan.description,
      features: plan.features,
      includes: PLANS.find((p) => p.key === plan.key)?.growthFeatures ?? [],
      recommended: plan.recommended,
      featured: plan.featured,
    })),
    addOns: sellableAddOns().map((addOn) => {
      const feature = GROWTH_FEATURES.find((f) => f.key === addOn.key)!;
      return { key: addOn.key, name: feature.name, summary: feature.summary, monthlyCents: addOn.monthlyCents };
    }),
    anchorDay: assigned ? anchorDayFor(assigned.billingDay) : null,
  };

  return { client, catalog };
}

export async function getCart(db: Database, ctx: TenantContext): Promise<CartState> {
  const opened = await openCart(db, ctx);
  if ("reason" in opened) return { open: false, reason: opened.reason };

  // An operator-attached promo is honoured here only when it is build-only;
  // one made for the plans still applies through the plan picker's checkout.
  let attachedPromo: Extract<CartState, { open: true }>["attachedPromo"] = null;
  if (opened.client.promoCodeId) {
    const code = await attachedCode(opened.client.promoCodeId);
    const checked = code ? await checkPromoFor(opened, code) : null;
    if (checked?.ok) {
      attachedPromo = { code: checked.promo.code, terms: checked.promo.terms, buildDueCents: checked.buildDueCents };
    }
  }

  return { open: true, catalog: opened.catalog, attachedPromo };
}

async function attachedCode(promotionCodeId: string): Promise<string | null> {
  try {
    return (await requireStripe().promotionCodes.retrieve(promotionCodeId)).code;
  } catch {
    return null;
  }
}

async function checkPromoFor(opened: Opened, code: string) {
  const buildProduct = await buildProductFor(opened.catalog.build.key);
  if (!buildProduct) {
    return { ok: false as const, message: "Codes can't be used just now. Please get in touch." };
  }
  return checkBuildPromo(code, {
    buildProductId: buildProduct,
    buildCents: opened.catalog.build.priceCents,
    customerId: opened.client.stripeCustomerId,
  });
}

async function buildProductFor(buildKey: string): Promise<string | null> {
  try {
    const found = await requireStripe().prices.list({ lookup_keys: [lookupKeyForBuild(buildKey)], active: true, limit: 1 });
    return found.data[0] ? productIdOf(found.data[0]) : null;
  } catch {
    return null;
  }
}

export type CartPromoResult =
  | { ok: true; code: string; terms: string; buildDueCents: number }
  | { ok: false; message: string };

/** A code the client typed, checked against Stripe and against the build-only rule. */
export async function checkCartPromo(db: Database, ctx: TenantContext, code: string): Promise<CartPromoResult> {
  const opened = await openCart(db, ctx);
  if ("reason" in opened) return { ok: false, message: CLOSED[opened.reason] };
  const checked = await checkPromoFor(opened, code);
  if (!checked.ok) return { ok: false, message: checked.message };
  return { ok: true, code: checked.promo.code, terms: checked.promo.terms, buildDueCents: checked.buildDueCents };
}

const CLOSED: Record<CartClosedReason, string> = {
  not_configured: "Card payments are not set up yet.",
  no_client: "Your account is not linked to a client record.",
  complimentary: "Your account is complimentary — there is nothing to pay.",
  internal: "There is nothing to pay on this account.",
  paid: "Your website is already paid for. Plans and add-ons are on the Plan tab.",
  subscribed: "You already pay by card. Plans and add-ons are on the Plan tab.",
  no_build: "We're still putting your website price together. We'll be in touch.",
};

export type CartCheckoutOutcome =
  | { ok: true; url: string; sessionId: string; reused: boolean }
  | {
      ok: false;
      reason:
        | CartClosedReason
        | "invalid_selection"
        | "promo"
        | "no_price"
        | "price_mismatch"
        | "already_subscribed"
        | "stripe_failed";
      message: string;
    };

export interface BeginCartCheckoutInput {
  planKey: string | null;
  addOnKeys: string[];
  /** As typed; empty for none. Re-checked here, never trusted from the page. */
  promoCode: string;
  /** Built server-side by the caller. */
  successUrl: string;
  cancelUrl: string;
}

interface Resolved {
  buildPrice: Stripe.Price;
  buildProduct: string;
  planPrice: Stripe.Price | null;
  addOnPrices: Stripe.Price[];
}

type Refusal = Extract<CartCheckoutOutcome, { ok: false }>;

function refusal(reason: Refusal["reason"], message: string): Refusal {
  return { ok: false, reason, message };
}

/**
 * Every price the cart charges, in one lookup, each checked against what the
 * page showed. A price that has moved in Stripe since the plans package was
 * last changed is a configuration error, and a client must not find it out
 * by being charged it.
 */
async function resolvePrices(catalog: CartCatalog, selection: CartSelection, quoted: boolean): Promise<Resolved | Refusal> {
  const buildKey = lookupKeyForBuild(catalog.build.key);
  const planKey = selection.planKey ? lookupKeyForPlan(selection.planKey as SellableKey) : null;
  const addOnKeys = selection.addOnKeys.map((key) => lookupKeyForAddOn(key as never));
  const wanted = [buildKey, ...(planKey ? [planKey] : []), ...addOnKeys];

  const found = await requireStripe().prices.list({ lookup_keys: wanted, active: true, limit: 10 });
  const byKey = new Map(found.data.map((price) => [price.lookup_key, price]));

  const missing = wanted.find((key) => !byKey.has(key));
  if (missing) {
    console.error("[cart] no Stripe price", { lookupKey: missing });
    return refusal("no_price", "Part of your order has no price set up yet. Please get in touch.");
  }

  const expected: Array<[string, number | null]> = [
    ...(quoted ? [] : [[buildKey, catalog.build.priceCents] as [string, number]]),
    ...(planKey && selection.planKey ? [[planKey, expectedCentsForPlan(selection.planKey as SellableKey)] as [string, number | null]] : []),
    ...selection.addOnKeys.map(
      (key, i) => [addOnKeys[i]!, catalog.addOns.find((a) => a.key === key)?.monthlyCents ?? null] as [string, number | null],
    ),
  ];
  const wrong = expected.find(([key, cents]) => byKey.get(key)!.unit_amount !== cents);
  if (wrong) {
    console.error("[cart] Stripe price disagrees with the plans package", {
      lookupKey: wrong[0],
      stripeCents: byKey.get(wrong[0])!.unit_amount,
      expectedCents: wrong[1],
    });
    return refusal("price_mismatch", "Our prices are being updated. Please try again later or get in touch.");
  }

  const buildPrice = byKey.get(buildKey)!;
  return {
    buildPrice,
    buildProduct: productIdOf(buildPrice),
    planPrice: planKey ? byKey.get(planKey)! : null,
    addOnPrices: addOnKeys.map((key) => byKey.get(key)!),
  };
}

/** What makes two checkouts the same order: a double click reuses, anything else replaces. */
function signatureOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/**
 * Reuse an open checkout for this exact order, and close every other one.
 *
 * Closing matters as much as reusing. A client who opened a checkout for Care,
 * came back and chose Growth, would otherwise hold two live payment pages —
 * and paying both starts two subscriptions and pays for the website twice.
 */
async function reuseOrClear(customerId: string, signature: string): Promise<Stripe.Checkout.Session | null> {
  const stripe = requireStripe();
  const open = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 20 });
  let reusable: Stripe.Checkout.Session | null = null;

  for (const session of open.data) {
    const isCart = session.metadata?.checkout === "cart";
    const live = !session.expires_at || session.expires_at * 1000 > Date.now();
    if (isCart && live && session.metadata?.cart_signature === signature && !reusable) {
      reusable = session;
      continue;
    }
    // A plan-picker checkout would start a subscription without the build.
    if (isCart || session.mode === "subscription") await stripe.checkout.sessions.expire(session.id);
  }

  return reusable;
}

export async function beginCartCheckout(
  db: Database,
  ctx: TenantContext,
  input: BeginCartCheckoutInput,
): Promise<CartCheckoutOutcome> {
  const opened = await openCart(db, ctx);
  if ("reason" in opened) return refusal(opened.reason, CLOSED[opened.reason]);
  const { client, catalog } = opened;

  const picked = selectionFrom(catalog, { planKey: input.planKey, addOnKeys: input.addOnKeys });
  if (!picked.ok) return refusal("invalid_selection", picked.message);
  const selection = picked.selection;
  const quoted = buildFor(client)!.quoted;

  try {
    const prices = await resolvePrices(catalog, selection, quoted);
    if ("ok" in prices) return prices;

    const customerId = await ensureCustomer(db, client);
    if (await liveSubscription(customerId)) {
      return refusal("already_subscribed", "You already have an active subscription. Use the Plan tab to change it.");
    }

    let promo: BuildPromo | null = null;
    let buildDueCents = catalog.build.priceCents;
    if (input.promoCode.trim()) {
      const checked = await checkBuildPromo(input.promoCode, {
        buildProductId: prices.buildProduct,
        buildCents: catalog.build.priceCents,
        customerId,
      });
      if (!checked.ok) return refusal("promo", checked.message);
      promo = checked.promo;
      buildDueCents = checked.buildDueCents;
    }

    const quote = quoteCart(catalog, selection, buildDueCents);
    const recurring = selection.planKey !== null;
    const signature = signatureOf({
      build: quoted ? { product: prices.buildProduct, cents: catalog.build.priceCents } : prices.buildPrice.id,
      plan: prices.planPrice?.id ?? null,
      addOns: prices.addOnPrices.map((p) => p.id).sort(),
      promo: promo?.id ?? null,
      anchor: recurring ? catalog.anchorDay : null,
    });

    const reusable = await reuseOrClear(customerId, signature);
    if (reusable?.url) return { ok: true, url: reusable.url, sessionId: reusable.id, reused: true };

    const session = await createCartSession({
      client,
      customerId,
      catalog,
      selection,
      prices,
      quoted,
      promo,
      signature,
      dueTodayCents: quote.dueTodayCents,
      urls: input,
    });
    if (!session.url) return refusal("stripe_failed", "Stripe did not return a checkout page. Please try again.");
    return { ok: true, url: session.url, sessionId: session.id, reused: false };
  } catch (error) {
    console.error("[cart] checkout failed", {
      clientId: client.clientId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return refusal("stripe_failed", "We could not start checkout just now. Nothing was charged. Please try again.");
  }
}

interface SessionInput {
  client: CartClient;
  customerId: string;
  catalog: CartCatalog;
  selection: CartSelection;
  prices: Resolved;
  quoted: boolean;
  promo: BuildPromo | null;
  signature: string;
  dueTodayCents: number;
  urls: { successUrl: string; cancelUrl: string };
}

/** A minute's grace for a double submit that beats the open-session lookup. */
const IDEMPOTENCY_WINDOW_MS = 60_000;

async function createCartSession(input: SessionInput): Promise<Stripe.Checkout.Session> {
  const { client, catalog, selection, prices } = input;
  const recurring = selection.planKey !== null;

  const buildLine: Stripe.Checkout.SessionCreateParams.LineItem = input.quoted
    ? { price_data: { currency: "usd", unit_amount: catalog.build.priceCents, product: prices.buildProduct }, quantity: 1 }
    : { price: prices.buildPrice.id, quantity: 1 };

  // Both copies carry the tenant: the session's for checkout events, the
  // subscription's for every invoice and subscription event after it. The
  // build product goes on both so the receiver can tell the build line on
  // the first invoice from the plan's.
  const tenant = { client_id: client.clientId, client_public_id: client.publicId };
  const cart = {
    checkout: "cart",
    build_key: catalog.build.key,
    build_product: prices.buildProduct,
    plan_key: selection.planKey ?? "",
  };

  return requireStripe().checkout.sessions.create(
    {
      mode: recurring ? "subscription" : "payment",
      customer: input.customerId,
      line_items: [
        buildLine,
        ...(prices.planPrice ? [{ price: prices.planPrice.id, quantity: 1 }] : []),
        ...prices.addOnPrices.map((price) => ({ price: price.id, quantity: 1 })),
      ],
      success_url: input.urls.successUrl,
      cancel_url: input.urls.cancelUrl,
      client_reference_id: client.publicId,
      metadata: {
        ...tenant,
        ...cart,
        add_ons: selection.addOnKeys.join(","),
        promo_code_id: input.promo?.id ?? "",
        cart_signature: input.signature,
        billing_day: recurring && catalog.anchorDay ? String(catalog.anchorDay) : "",
        due_today_cents: String(input.dueTodayCents),
      },
      // The code the client typed and the page checked, and no box on
      // Stripe's page: a code typed there could come off the plan.
      ...(input.promo ? { discounts: [{ promotion_code: input.promo.id }] } : {}),
      billing_address_collection: "auto",
      ...(recurring
        ? {
            payment_method_collection: "always" as const,
            subscription_data: {
              metadata: { ...tenant, ...cart },
              ...(catalog.anchorDay ? { billing_cycle_anchor_config: { day_of_month: catalog.anchorDay } } : {}),
            },
          }
        : {
            payment_intent_data: {
              description: `${catalog.build.name} for ${client.businessName}`,
              metadata: { ...tenant, ...cart },
            },
          }),
    },
    {
      idempotencyKey: `cart:${client.clientId}:${input.signature}:${Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS)}`,
    },
  );
}
