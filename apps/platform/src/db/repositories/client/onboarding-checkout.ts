import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { BUILD, type GrowthFeatureKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { auditLog, clients, organizations, paymentRequests, servicePlans, sites, subscriptions } from "@/db/schema";
import { anchorDayFor } from "@/lib/billing/billing-day";
import { businessDate } from "@/lib/billing/period";
import {
  BUILD_LINE_NAME,
  basketSignature,
  buildWelcomeBasket,
  stripeLineItems,
  type Basket,
  type BasketRefusalReason,
  type CheckoutLineItem,
  type PriceRef,
  type SiteDue,
} from "@/lib/onboarding/checkout";
import { priceForBuild, productIdOf } from "@/lib/payments/build";
import { usablePromo } from "@/lib/payments/promos";
import {
  priceForAddOn,
  priceForPlan,
  requireStripe,
  stripeConfigured,
  type SellableKey,
} from "@/lib/payments/stripe";
import { generatePaymentReference } from "@/lib/payments/venmo";
import { buildInvoicePublicId, buildStandingFor } from "../build-standing";
import { assertMutable, type TenantContext } from "../context";
import { sellablePlanCards, type PlanCard } from "./plan-choice";
import { beginStripePayment } from "./stripe-payment";
import { assignedPlanFor, ensureCustomer, liveSubscription, type ResolvedClient } from "./stripe-checkout";

/**
 * The welcome checkout: paying for the site, and optionally a plan and
 * add-ons, on a new client's first visit — in one Stripe Checkout.
 *
 * ## One checkout, using what already settles payments
 *
 * - **A plan is chosen** → a subscription-mode session: the plan, add-ons and
 *   build each by price id — the build on the "Website build" product, as a
 *   one-time line Stripe puts on the first invoice only. Settled by the
 *   receiver's `invoice.paid` path, which records the build and the plan as
 *   two ledger rows and marks the build paid; the add-on lines are mirrored by
 *   `syncStripeAddOns` exactly as if added from the Plan tab.
 * - **Only the build** → a payment-mode session through `beginStripePayment`,
 *   against an invoice for the build made here (`purpose = 'build'`). That is
 *   the one-off path every operator-raised invoice already takes, so its
 *   settlement, receipt and double-click guards are reused rather than
 *   repeated, and settling it is what marks the build paid.
 *
 * An invoice an operator already raised is never put in this basket: it is
 * paid with its own button, on its own reference (see `buildWelcomeBasket`).
 *
 * ## What the browser decides
 *
 * A plan key and a list of add-on keys — never a price, an amount, a
 * customer or a tenant. The plan must be one this client is offered
 * (`sellablePlanCards`), the add-ons are checked against the plans package,
 * and what the site costs comes from the database.
 */

const OPEN_SITE_INVOICE = ["open", "overdue", "awaiting_confirmation"] as const;

export interface WelcomeClient extends ResolvedClient {
  isInternal: boolean;
  buildPaidAt: Date | null;
  freeBuildOn: string | null;
  promoCode: string | null;
  promoTerms: string | null;
}

async function welcomeClient(db: Database, ctx: TenantContext): Promise<WelcomeClient | null> {
  const [row] = await db
    .select({
      clientId: clients.id,
      publicId: clients.publicId,
      businessName: organizations.name,
      contactEmail: clients.primaryContactEmail,
      stripeCustomerId: clients.stripeCustomerId,
      compPlanId: clients.compPlanId,
      promoCodeId: clients.promoCodeId,
      promoCode: clients.promoCode,
      promoTerms: clients.promoTerms,
      isInternal: clients.isInternal,
      buildPaidAt: clients.buildPaidAt,
      freeBuildOn: clients.freeBuildOn,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  return row ?? null;
}

export { buildInvoicePublicId };

/**
 * What this client owes for their website, from the billing records.
 *
 * In order: on the house; the agency's own site; the build paid
 * (`clients.build_paid_at` — its own line or invoice, never some other
 * payment); an invoice open for them; the build waived; and otherwise the
 * published build price. "Paid" comes before open invoices, so a
 * long-standing client's monthly invoice is never mistaken for their site.
 */
export async function siteDueFor(
  db: Database,
  client: Pick<WelcomeClient, "clientId" | "compPlanId" | "isInternal" | "buildPaidAt" | "freeBuildOn">,
): Promise<SiteDue> {
  const standing = await buildStandingFor(db, client);
  if (standing.settled && standing.reason !== "waived") return { kind: "none", reason: standing.reason };

  const open = await db
    .select({
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      currency: paymentRequests.currency,
      note: paymentRequests.note,
      dueOn: paymentRequests.dueOn,
      status: paymentRequests.status,
    })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.clientId, client.clientId),
        inArray(paymentRequests.status, [...OPEN_SITE_INVOICE]),
        // A top-up for one change is not what the site costs.
        ne(paymentRequests.purpose, "extra_change"),
      ),
    )
    .orderBy(sql`${paymentRequests.dueOn} asc nulls last`, asc(paymentRequests.createdAt));
  const first = open[0];
  if (first) {
    return {
      kind: "invoice",
      ...first,
      status: first.status as (typeof OPEN_SITE_INVOICE)[number],
      others: open.length - 1,
    };
  }

  if (standing.settled) return { kind: "none", reason: "waived" };
  return { kind: "build", amountCents: BUILD.priceCents };
}

/** The plan a processor already charges this client for, if any: nothing to choose here then. */
async function processorBilledPlan(db: Database, clientId: string): Promise<{ name: string | null } | null> {
  const [row] = await db
    .select({ name: servicePlans.name })
    .from(subscriptions)
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(
      and(eq(subscriptions.clientId, clientId), eq(subscriptions.status, "active"), isNotNull(subscriptions.provider)),
    )
    .limit(1);
  return row ?? null;
}

export interface WelcomeOffer {
  businessName: string;
  /** Whether the combined checkout can open a Stripe page here. */
  stripeReady: boolean;
  siteDue: SiteDue;
  /** Null when no plan can be chosen here: on the house, or already billed by a processor. */
  plans: PlanCard[] | null;
  /** The plan they already pay for, when `plans` is null for that reason. */
  currentPlanName: string | null;
  billingDay: number | null;
  /** A promo an operator attached, as it was described when attached. */
  promo: { code: string; terms: string | null } | null;
  /** The site the agent built, to look at before paying to put it live. Null before it has a URL. */
  preview: SitePreviewView | null;
}

export interface SitePreviewView {
  name: string;
  /** Where the built site can be opened: its Netlify address until it is live on the domain. */
  url: string;
  live: boolean;
}

/**
 * The client's site as they can see it today (decision D1: the preview comes
 * first, payment puts it live). The business's first site. Before launch its
 * domain still points at whatever was there, so the address is the Netlify
 * one the deploy publishes to.
 */
async function sitePreviewFor(db: Database, ctx: TenantContext): Promise<SitePreviewView | null> {
  const [site] = await db
    .select({
      name: sites.name,
      status: sites.status,
      primaryDomain: sites.primaryDomain,
      productionUrl: sites.productionUrl,
      netlifySiteName: sites.netlifySiteName,
    })
    .from(sites)
    .where(and(eq(sites.organizationId, ctx.organizationId), isNull(sites.archivedAt)))
    .orderBy(asc(sites.createdAt))
    .limit(1);
  if (!site) return null;

  const live = site.status === "live";
  const url = live
    ? (site.productionUrl ?? (site.primaryDomain ? `https://${site.primaryDomain}` : null))
    : site.netlifySiteName
      ? `https://${site.netlifySiteName}.netlify.app`
      : null;
  return url ? { name: site.name, url, live } : null;
}

/** Everything the welcome page shows. Null when the account has no client record. */
export async function getWelcomeOffer(db: Database, ctx: TenantContext): Promise<WelcomeOffer | null> {
  const client = await welcomeClient(db, ctx);
  if (!client) return null;

  const [siteDue, billed, preview] = await Promise.all([
    siteDueFor(db, client),
    processorBilledPlan(db, client.clientId),
    sitePreviewFor(db, ctx),
  ]);
  const choosable = !client.compPlanId && !billed;
  const cards = choosable ? await sellablePlanCards(db, client.clientId) : null;

  return {
    businessName: client.businessName,
    stripeReady: stripeConfigured(),
    siteDue,
    plans: cards?.plans ?? null,
    currentPlanName: billed?.name ?? null,
    billingDay: cards?.billingDay ?? null,
    promo: client.promoCode ? { code: client.promoCode, terms: client.promoTerms } : null,
    preview,
  };
}

export interface BeginWelcomeCheckoutInput {
  /** A plan key, or null for no plan. Never a price. */
  planKey: string | null;
  addOns: string[];
  /** Built server-side by the caller. */
  successUrl: string;
  cancelUrl: string;
}

export type WelcomeCheckoutOutcome =
  | { ok: true; url: string; mode: Basket["mode"]; reused: boolean }
  | {
      ok: false;
      reason:
        | BasketRefusalReason
        | "not_configured"
        | "no_client"
        | "complimentary"
        | "already_subscribed"
        | "nothing_to_pay"
        | "no_price"
        | "not_found"
        | "not_payable"
        | "processing"
        | "stripe_failed";
      message: string;
    };

const NOT_CONFIGURED: WelcomeCheckoutOutcome = {
  ok: false,
  reason: "not_configured",
  message: "Card payments aren't switched on yet, so this can't be paid online today. We'll send you a payment link.",
};

export async function beginWelcomeCheckout(
  db: Database,
  ctx: TenantContext,
  input: BeginWelcomeCheckoutInput,
): Promise<WelcomeCheckoutOutcome> {
  assertMutable(ctx);
  if (!stripeConfigured()) return NOT_CONFIGURED;

  const client = await welcomeClient(db, ctx);
  if (!client) return { ok: false, reason: "no_client", message: "Your account is not linked to a client record." };
  if (client.compPlanId) {
    return { ok: false, reason: "complimentary", message: "Your account is on a complimentary plan — there is nothing to pay." };
  }

  const [siteDue, billed] = await Promise.all([siteDueFor(db, client), processorBilledPlan(db, client.clientId)]);
  if (billed && (input.planKey || input.addOns.length > 0)) {
    return {
      ok: false,
      reason: "already_subscribed",
      message: "You already have a plan. Change it, or add tools, from the Plan tab.",
    };
  }
  const offered = billed ? [] : (await sellablePlanCards(db, client.clientId)).plans;

  const built = buildWelcomeBasket({
    siteDue,
    plans: offered.map((p) => ({ key: p.key, name: p.name, monthlyCents: p.monthlyCents })),
    planKey: input.planKey,
    addOns: input.addOns,
  });
  if (!built.ok) return { ok: false, reason: built.reason, message: built.message };
  if (!built.basket) {
    // Nothing chosen and an invoice open — including the build invoice a
    // first press made, met again on a second press or after the back
    // button. Paying it is what they asked for.
    if (siteDue.kind === "invoice") return payInvoice(db, ctx, siteDue.publicId, input);
    return { ok: false, reason: "nothing_to_pay", message: "There is nothing to pay right now." };
  }

  if (built.basket.mode === "payment") return payForBuild(db, ctx, client, built.basket, input);
  return subscribe(db, client, built.basket, input);
}

/**
 * The build on its own: an invoice for it, then the ordinary one-off card
 * payment for that invoice. The invoice exists from the moment they press
 * pay, so it is on Billing — and on the operator's list — if they stop at
 * Stripe's page, and the derived id keeps it to one per client.
 */
async function payForBuild(
  db: Database,
  ctx: TenantContext,
  client: WelcomeClient,
  basket: Basket,
  urls: { successUrl: string; cancelUrl: string },
): Promise<WelcomeCheckoutOutcome> {
  const build = basket.lines.find((l) => l.kind === "build")!;
  const requestPublicId = await ensureBuildInvoice(db, ctx, client, build.amountCents);
  return payInvoice(db, ctx, requestPublicId, urls);
}

async function payInvoice(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
  urls: { successUrl: string; cancelUrl: string },
): Promise<WelcomeCheckoutOutcome> {
  const outcome = await beginStripePayment(db, ctx, {
    requestPublicId,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason, message: outcome.message };
  return { ok: true, url: outcome.url, mode: "payment", reused: outcome.reused };
}

async function ensureBuildInvoice(
  db: Database,
  ctx: TenantContext,
  client: WelcomeClient,
  amountCents: number,
): Promise<string> {
  const publicId = await buildInvoicePublicId(client.clientId);

  let reference = generatePaymentReference();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [taken] = await db
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.reference, reference))
      .limit(1);
    if (!taken) break;
    reference = generatePaymentReference();
  }

  const inserted = await db
    .insert(paymentRequests)
    .values({
      publicId,
      clientId: client.clientId,
      reference,
      amountCents,
      dueOn: businessDate(),
      note: BUILD_LINE_NAME,
      status: "open",
      purpose: "build",
    })
    // On the public id only: a clash on the reference is a real error, not
    // a second press of the button.
    .onConflictDoNothing({ target: paymentRequests.publicId })
    .returning({ publicId: paymentRequests.publicId });

  if (inserted[0]) {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      organizationId: ctx.organizationId,
      action: "payment_request.raised",
      entityType: "payment_request",
      entityId: publicId,
      metadata: { amountCents, reference, by: "client", source: "welcome_checkout" },
    });
  }
  return publicId;
}

/**
 * A plan, with any add-ons and the build, as one subscription checkout.
 *
 * The same guards as choosing a plan from Billing (`stripe-checkout.ts`):
 * one Stripe customer per client, no second live subscription, the payment
 * day an operator set, an attached promo re-checked and dropped if refused,
 * and an open session for the same choice handed back rather than a new one.
 */
async function subscribe(
  db: Database,
  client: WelcomeClient,
  basket: Basket,
  urls: { successUrl: string; cancelUrl: string },
): Promise<WelcomeCheckoutOutcome> {
  try {
    const planPrice = basket.planKey ? await priceForPlan(basket.planKey as SellableKey) : null;
    const addOnPrices: Partial<Record<GrowthFeatureKey, PriceRef>> = {};
    for (const key of basket.addOns) {
      const price = await priceForAddOn(key);
      if (price) addOnPrices[key] = { id: price.id };
    }
    const buildPrice = basket.includesBuild ? await priceForBuild() : null;
    const items = stripeLineItems(basket, {
      plan: planPrice ? { id: planPrice.id } : null,
      addOns: addOnPrices,
      build: buildPrice ? { id: buildPrice.id } : null,
    });
    if (!items.ok) {
      return {
        ok: false,
        reason: "no_price",
        message: `${items.missing} can't be bought just yet. Untick it, or get in touch.`,
      };
    }

    const customerId = await ensureCustomer(db, client);
    if (await liveSubscription(customerId)) {
      return {
        ok: false,
        reason: "already_subscribed",
        message: "You already have an active subscription. Use “Manage billing” to change it.",
      };
    }

    const assigned = await assignedPlanFor(db, client.clientId);
    const anchorDay = assigned ? anchorDayFor(assigned.billingDay) : null;
    const promo = client.promoCodeId ? await usablePromo(client.promoCodeId) : null;
    const session = await welcomeSession({
      customerId,
      client,
      basket,
      items: items.items,
      anchorDay,
      promoCodeId: promo?.id ?? "",
      buildProductId: buildPrice ? productIdOf(buildPrice) : "",
      urls,
    });
    if (!session.url) {
      return { ok: false, reason: "stripe_failed", message: "Stripe did not return a checkout page. Please try again." };
    }
    return { ok: true, url: session.url, mode: "subscription", reused: session.reused };
  } catch (error) {
    console.error("[stripe:welcome] failed", {
      clientId: client.clientId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, reason: "stripe_failed", message: "We could not start checkout just now. Please try again." };
  }
}

interface WelcomeSessionInput {
  customerId: string;
  client: WelcomeClient;
  basket: Basket;
  items: CheckoutLineItem[];
  anchorDay: number | null;
  /** Empty when no promo is attached, or it can no longer be used. */
  promoCodeId: string;
  /** The "Website build" product, when the build is in the basket. */
  buildProductId: string;
  urls: { successUrl: string; cancelUrl: string };
}

async function welcomeSession(input: WelcomeSessionInput): Promise<{ url: string | null; reused: boolean }> {
  const stripe = requireStripe();
  const { client, basket, anchorDay } = input;
  const signature = basketSignature(basket);
  const billingDay = anchorDay ? String(anchorDay) : "";

  const open = await stripe.checkout.sessions.list({ customer: input.customerId, status: "open", limit: 20 });
  const reusable = open.data.find(
    (s) =>
      s.mode === "subscription" &&
      s.metadata?.source === "welcome" &&
      s.metadata?.welcome_basket === signature &&
      (s.metadata?.billing_day ?? "") === billingDay &&
      (s.metadata?.promo_code_id ?? "") === input.promoCodeId &&
      !(s.expires_at && s.expires_at * 1000 < Date.now()),
  );
  if (reusable?.url) return { url: reusable.url, reused: true };

  const create = (promoCodeId: string) =>
    stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: input.customerId,
        line_items: input.items as Stripe.Checkout.SessionCreateParams.LineItem[],
        success_url: input.urls.successUrl,
        cancel_url: input.urls.cancelUrl,
        client_reference_id: client.publicId,
        subscription_data: {
          // What every later subscription and invoice event carries; the
          // receiver matches the tenant on it, and finds the build's line on
          // the first invoice by `build_product`.
          metadata: {
            client_public_id: client.publicId,
            client_id: client.clientId,
            plan_key: basket.planKey ?? "",
            build_product: input.buildProductId,
          },
          ...(anchorDay ? { billing_cycle_anchor_config: { day_of_month: anchorDay } } : {}),
        },
        metadata: {
          client_public_id: client.publicId,
          client_id: client.clientId,
          plan_key: basket.planKey ?? "",
          billing_day: billingDay,
          promo_code_id: promoCodeId,
          source: "welcome",
          welcome_basket: signature,
        },
        payment_method_collection: "always",
        billing_address_collection: "auto",
        ...(promoCodeId ? { discounts: [{ promotion_code: promoCodeId }] } : { allow_promotion_codes: true }),
      },
      {
        idempotencyKey: `welcome:${client.clientId}:${signature}:${billingDay || "now"}:${promoCodeId || "nopromo"}`,
      },
    );

  if (!input.promoCodeId) return { url: (await create("")).url, reused: false };
  try {
    return { url: (await create(input.promoCodeId)).url, reused: false };
  } catch (error) {
    // Only a refusal of the request. An outage is not a reason to charge the
    // full price to someone told it would be discounted.
    if ((error as { type?: string } | null)?.type !== "StripeInvalidRequestError") throw error;
    console.error("[stripe:welcome] promo refused, continuing without it", {
      clientId: client.clientId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { url: (await create("")).url, reused: false };
  }
}
