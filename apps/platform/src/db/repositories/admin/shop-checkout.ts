import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import {
  organizationMemberships,
  organizations,
  shopOrderItems,
  shopOrders,
  shopProductEvents,
  shopProducts,
  shopSettings,
  sites,
  users,
} from "@/db/schema";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { newPublicId } from "@/lib/ids";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { buildNewOrderEmail, type ShippingAddress } from "@/lib/shop/emails";
import {
  CHECKOUT_EXPIRY_MINUTES,
  CHECKOUT_SWEEP_GRACE_MINUTES,
  checkoutReturnUrls,
  returnBase,
  SHIP_TO_COUNTRIES,
  siteOrigins,
  type CheckoutRequest,
} from "@/lib/shop/public";

/**
 * Money moving through a client's shop, with no session on either end: the
 * visitor starting a checkout, and Stripe reporting what became of it.
 *
 * ## Stock is never read then written
 *
 * Holding a unit for a checkout is one conditional UPDATE: it succeeds only
 * while `stock - reserved` still covers the quantity, so two buyers after the
 * last piece cannot both get a session. Selling and releasing are the same
 * shape. Nothing in this file decides from a number it fetched a moment ago.
 *
 * ## The order row is the reservation's receipt
 *
 * It is written before Stripe is asked for a session, under a placeholder
 * session id, so a crash between the two leaves a pending order the sweep
 * can expire and release — never a held unit nothing remembers.
 *
 * ## Stripe is re-asked, never believed
 *
 * `checkout.session.completed` is processed by re-fetching the session from
 * the connected account, as the platform receiver does for subscriptions.
 * What is written is what Stripe says now.
 */

const ORDER_SELECT = {
  id: shopOrders.id,
  publicId: shopOrders.publicId,
  organizationId: shopOrders.organizationId,
  siteId: shopOrders.siteId,
  stripeAccountId: shopOrders.stripeAccountId,
  stripeSessionId: shopOrders.stripeSessionId,
  status: shopOrders.status,
  fulfilment: shopOrders.fulfilment,
  expiresAt: shopOrders.expiresAt,
};

export type CheckoutStart =
  | { ok: true; url: string; orderPublicId: string }
  | {
      ok: false;
      reason: "unknown_site" | "not_open" | "unknown_product" | "sold_out" | "no_return" | "stripe_failed";
      message: string;
    };

const placeholderSession = (orderPublicId: string) => `pending:${orderPublicId}`;

/** Try to hold `quantity` units. True when they are held. */
async function reserve(db: Database, productId: string, quantity: number): Promise<boolean> {
  const held = await db
    .update(shopProducts)
    .set({ reserved: sql`${shopProducts.reserved} + ${quantity}`, updatedAt: new Date() })
    .where(
      and(
        eq(shopProducts.id, productId),
        eq(shopProducts.status, "active"),
        isNull(shopProducts.deletedAt),
        sql`(${shopProducts.stock} IS NULL OR ${shopProducts.stock} - ${shopProducts.reserved} >= ${quantity})`,
      ),
    )
    .returning({ id: shopProducts.id });
  return held.length > 0;
}

async function release(db: Database, productId: string, quantity: number): Promise<void> {
  await db
    .update(shopProducts)
    .set({ reserved: sql`GREATEST(${shopProducts.reserved} - ${quantity}, 0)`, updatedAt: new Date() })
    .where(eq(shopProducts.id, productId));
}

/** A held unit becomes a sold one: off the shelf and out of the hold in one step. */
async function sell(db: Database, productId: string, quantity: number): Promise<void> {
  await db
    .update(shopProducts)
    .set({
      stock: sql`CASE WHEN ${shopProducts.stock} IS NULL THEN NULL ELSE GREATEST(${shopProducts.stock} - ${quantity}, 0) END`,
      reserved: sql`GREATEST(${shopProducts.reserved} - ${quantity}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(shopProducts.id, productId));
}

async function stockEvent(
  db: Database,
  productId: string,
  organizationId: string,
  action: "stock_reserved" | "stock_sold" | "stock_released",
  changes: Record<string, unknown>,
): Promise<void> {
  await db.insert(shopProductEvents).values({ productId, organizationId, actorId: null, action, changes });
}

export interface CheckoutContext {
  sitePublicId: string;
  request: CheckoutRequest;
  /** The portal's https origin, for product images on the Stripe page. */
  portalBase: string | null;
  now?: Date;
}

export async function beginShopCheckout(db: Database, input: CheckoutContext): Promise<CheckoutStart> {
  const now = input.now ?? new Date();
  const [site] = await db
    .select({
      id: sites.id,
      organizationId: sites.organizationId,
      primaryDomain: sites.primaryDomain,
      productionUrl: sites.productionUrl,
      netlifySiteName: sites.netlifySiteName,
    })
    .from(sites)
    .where(and(eq(sites.publicId, input.sitePublicId), isNull(sites.archivedAt)))
    .limit(1);
  if (!site) return { ok: false, reason: "unknown_site", message: "Unknown site." };

  const [settings] = await db.select().from(shopSettings).where(eq(shopSettings.siteId, site.id)).limit(1);
  if (!settings?.stripeAccountId || !settings.chargesEnabled || !stripeConfigured()) {
    return { ok: false, reason: "not_open", message: "This shop is not taking payments yet." };
  }

  const base = returnBase(siteOrigins(site), input.request.returnTo);
  if (!base) return { ok: false, reason: "no_return", message: "This shop is not taking payments yet." };

  const [product] = await db
    .select({ id: shopProducts.id, publicId: shopProducts.publicId, name: shopProducts.name, priceCents: shopProducts.priceCents })
    .from(shopProducts)
    .where(
      and(
        eq(shopProducts.publicId, input.request.productId),
        eq(shopProducts.siteId, site.id),
        eq(shopProducts.status, "active"),
        isNull(shopProducts.deletedAt),
      ),
    )
    .limit(1);
  if (!product) return { ok: false, reason: "unknown_product", message: "That product is not for sale." };

  const quantity = input.request.quantity;
  if (!(await reserve(db, product.id, quantity))) {
    return { ok: false, reason: "sold_out", message: quantity === 1 ? "Sorry, that one has just sold." : "Sorry, there are not that many left." };
  }

  const orderPublicId = newPublicId();
  const shippingCents = settings.fulfilment === "ship" ? settings.shippingCents : 0;
  const subtotalCents = product.priceCents * quantity;
  const expiresAt = new Date(now.getTime() + CHECKOUT_EXPIRY_MINUTES * 60 * 1000);
  const [order] = await db
    .insert(shopOrders)
    .values({
      publicId: orderPublicId,
      organizationId: site.organizationId,
      siteId: site.id,
      stripeAccountId: settings.stripeAccountId,
      stripeSessionId: placeholderSession(orderPublicId),
      fulfilment: settings.fulfilment,
      subtotalCents,
      shippingCents,
      totalCents: subtotalCents + shippingCents,
      currency: settings.currency,
      expiresAt,
    })
    .returning({ id: shopOrders.id });
  await db.insert(shopOrderItems).values({ orderId: order!.id, productId: product.id, name: product.name, unitCents: product.priceCents, quantity });
  await stockEvent(db, product.id, site.organizationId, "stock_reserved", { order: orderPublicId, quantity });

  const urls = checkoutReturnUrls(base, orderPublicId);
  const metadata = { site_public_id: input.sitePublicId, order_public_id: orderPublicId, product_public_id: product.publicId };
  try {
    const session = await requireStripe().checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity,
            price_data: {
              currency: settings.currency,
              unit_amount: product.priceCents,
              product_data: {
                name: product.name,
                ...(input.portalBase
                  ? { images: [`${input.portalBase}/api/public/sites/${input.sitePublicId}/shop/products/${product.publicId}/images/0`] }
                  : {}),
              },
            },
          },
        ],
        ...(settings.fulfilment === "ship"
          ? {
              shipping_address_collection: { allowed_countries: [...SHIP_TO_COUNTRIES] },
              ...(shippingCents > 0
                ? {
                    shipping_options: [
                      {
                        shipping_rate_data: {
                          type: "fixed_amount",
                          display_name: "Shipping",
                          fixed_amount: { amount: shippingCents, currency: settings.currency },
                        },
                      },
                    ],
                  }
                : {}),
            }
          : {}),
        ...(settings.taxEnabled ? { automatic_tax: { enabled: true } } : {}),
        allow_promotion_codes: true,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        success_url: urls.success,
        cancel_url: urls.cancel,
        client_reference_id: orderPublicId,
        metadata,
        payment_intent_data: { metadata, description: product.name },
      },
      { stripeAccount: settings.stripeAccountId, idempotencyKey: `shop-checkout:${orderPublicId}` },
    );
    await db.update(shopOrders).set({ stripeSessionId: session.id, updatedAt: new Date() }).where(eq(shopOrders.id, order!.id));
    return { ok: true, url: session.url ?? urls.cancel, orderPublicId };
  } catch (error) {
    console.error("[shop] checkout session failed", {
      site: input.sitePublicId,
      order: orderPublicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    // Give the unit back now rather than in thirty minutes.
    await release(db, product.id, quantity);
    await db.update(shopOrders).set({ status: "expired", updatedAt: new Date() }).where(eq(shopOrders.id, order!.id));
    await stockEvent(db, product.id, site.organizationId, "stock_released", { order: orderPublicId, quantity, reason: "stripe_failed" });
    return { ok: false, reason: "stripe_failed", message: "Checkout could not be started just now. Please try again in a minute." };
  }
}

// ---------------------------------------------------------------------------
// What Stripe reports
// ---------------------------------------------------------------------------

export type SettleOutcome = { status: "processed" | "ignored" | "unmatched"; note: string };

async function orderBySession(db: Database, sessionId: string) {
  const [row] = await db.select(ORDER_SELECT).from(shopOrders).where(eq(shopOrders.stripeSessionId, sessionId)).limit(1);
  return row ?? null;
}

async function itemsOf(db: Database, orderId: string) {
  return db
    .select({ productId: shopOrderItems.productId, name: shopOrderItems.name, unitCents: shopOrderItems.unitCents, quantity: shopOrderItems.quantity })
    .from(shopOrderItems)
    .where(eq(shopOrderItems.orderId, orderId));
}

function shippingAddressOf(session: Stripe.Checkout.Session): ShippingAddress | null {
  const details =
    (session as { collected_information?: { shipping_details?: Stripe.Checkout.Session.CollectedInformation.ShippingDetails | null } | null })
      .collected_information?.shipping_details ??
    (session as { shipping_details?: { name?: string | null; address?: Stripe.Address | null } | null }).shipping_details ??
    null;
  if (!details?.address) return null;
  const a = details.address;
  return { name: details.name ?? null, line1: a.line1, line2: a.line2, city: a.city, state: a.state, postalCode: a.postal_code, country: a.country };
}

export interface SettleOptions {
  send?: (message: EmailMessage) => Promise<SendResult>;
  portalBase?: string | null;
  now?: Date;
}

/**
 * A paid session: the order becomes paid, held units become sold, and the
 * client hears about it. Idempotent on the order's status, so a replayed
 * event or a sweep finding the same session changes nothing twice.
 */
export async function settleCheckoutSession(
  db: Database,
  session: Stripe.Checkout.Session,
  options: SettleOptions = {},
): Promise<SettleOutcome> {
  const order = await orderBySession(db, session.id);
  if (!order) return { status: "unmatched", note: `no order for session ${session.id}` };
  if (order.status !== "pending") return { status: "ignored", note: `order ${order.publicId} is already ${order.status}` };
  if (session.payment_status !== "paid") return { status: "ignored", note: `session ${session.id} is ${session.payment_status}` };

  const now = options.now ?? new Date();
  const address = shippingAddressOf(session);
  const intent = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  const claimed = await db
    .update(shopOrders)
    .set({
      status: "paid",
      paidAt: now,
      stripePaymentIntentId: intent,
      buyerName: session.customer_details?.name ?? address?.name ?? null,
      buyerEmail: session.customer_details?.email ?? null,
      shippingAddress: address,
      subtotalCents: session.amount_subtotal ?? undefined,
      shippingCents: session.total_details?.amount_shipping ?? undefined,
      taxCents: session.total_details?.amount_tax ?? undefined,
      totalCents: session.amount_total ?? undefined,
      updatedAt: now,
    })
    // The status check again, in the write: two deliveries racing both read
    // "pending" above, and only one may convert the stock.
    .where(and(eq(shopOrders.id, order.id), eq(shopOrders.status, "pending")))
    .returning({ id: shopOrders.id, totalCents: shopOrders.totalCents, buyerName: shopOrders.buyerName, buyerEmail: shopOrders.buyerEmail });
  if (claimed.length === 0) return { status: "ignored", note: `order ${order.publicId} settled by another delivery` };

  const items = await itemsOf(db, order.id);
  for (const item of items) {
    if (!item.productId) continue;
    await sell(db, item.productId, item.quantity);
    await stockEvent(db, item.productId, order.organizationId, "stock_sold", { order: order.publicId, quantity: item.quantity });
  }

  await notifyClientOfOrder(db, {
    organizationId: order.organizationId,
    orderPublicId: order.publicId,
    fulfilment: order.fulfilment === "pickup" ? "pickup" : "ship",
    buyerName: claimed[0]!.buyerName,
    buyerEmail: claimed[0]!.buyerEmail,
    totalCents: claimed[0]!.totalCents,
    items,
    shippingAddress: address,
    portalBase: options.portalBase ?? null,
    send: options.send ?? sendEmail,
  });

  return { status: "processed", note: `order ${order.publicId} paid` };
}

/** An abandoned session: the order expires and the held units go back on the shelf. */
export async function expireCheckoutSession(db: Database, sessionId: string, now = new Date()): Promise<SettleOutcome> {
  const order = await orderBySession(db, sessionId);
  if (!order) return { status: "unmatched", note: `no order for session ${sessionId}` };
  return expireOrder(db, order, now);
}

async function expireOrder(
  db: Database,
  order: { id: string; publicId: string; organizationId: string; status: string },
  now: Date,
): Promise<SettleOutcome> {
  const claimed = await db
    .update(shopOrders)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(shopOrders.id, order.id), eq(shopOrders.status, "pending")))
    .returning({ id: shopOrders.id });
  if (claimed.length === 0) return { status: "ignored", note: `order ${order.publicId} is already ${order.status}` };

  for (const item of await itemsOf(db, order.id)) {
    if (!item.productId) continue;
    await release(db, item.productId, item.quantity);
    await stockEvent(db, item.productId, order.organizationId, "stock_released", { order: order.publicId, quantity: item.quantity });
  }
  return { status: "processed", note: `order ${order.publicId} expired` };
}

/**
 * A refund on the connected account. The order is marked refunded and that
 * is all: damaged goods come back unsellable, so putting units back on the
 * shelf is the client's deliberate click, never automatic. A partial refund
 * is recorded as a refund too — the client sees it and decides.
 */
export async function recordShopRefund(db: Database, charge: Stripe.Charge, now = new Date()): Promise<SettleOutcome> {
  const intent = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null);
  if (!intent) return { status: "unmatched", note: `charge ${charge.id} has no payment intent` };
  const updated = await db
    .update(shopOrders)
    .set({ status: "refunded", refundedAt: now, updatedAt: now })
    .where(and(eq(shopOrders.stripePaymentIntentId, intent), inArray(shopOrders.status, ["paid", "shipped"])))
    .returning({ publicId: shopOrders.publicId });
  if (updated.length === 0) return { status: "unmatched", note: `no paid order for ${intent}` };
  return { status: "processed", note: `order ${updated[0]!.publicId} refunded (${charge.amount_refunded} of ${charge.amount})` };
}

// ---------------------------------------------------------------------------
// The net
// ---------------------------------------------------------------------------

/**
 * Pending orders past their expiry, for the scheduler. Each is looked up at
 * Stripe first: a lost `completed` webhook must become a sale, not a release.
 * A session that cannot be read (Stripe down, a placeholder id from a crash
 * before the session existed) is expired only after the grace period.
 */
export async function reconcileStaleCheckouts(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<{ checked: number; settled: number; expired: number; left: number }> {
  const now = options.now ?? new Date();
  const stale = await db
    .select(ORDER_SELECT)
    .from(shopOrders)
    .where(and(eq(shopOrders.status, "pending"), lt(shopOrders.expiresAt, now)))
    .limit(options.limit ?? 25);

  let settled = 0;
  let expired = 0;
  let left = 0;
  for (const order of stale) {
    const graceOver = order.expiresAt.getTime() + CHECKOUT_SWEEP_GRACE_MINUTES * 60 * 1000 < now.getTime();
    if (order.stripeSessionId.startsWith("pending:")) {
      // No session was ever made for it; nothing at Stripe to ask.
      if (graceOver) {
        await expireOrder(db, order, now);
        expired += 1;
      } else left += 1;
      continue;
    }
    try {
      const session = await requireStripe().checkout.sessions.retrieve(order.stripeSessionId, undefined, { stripeAccount: order.stripeAccountId });
      if (session.payment_status === "paid") {
        const outcome = await settleCheckoutSession(db, session, { now });
        if (outcome.status === "processed") settled += 1;
      } else if (session.status === "expired" || graceOver) {
        await expireOrder(db, order, now);
        expired += 1;
      } else left += 1;
    } catch (error) {
      console.warn("[shop] could not read a stale session", { order: order.publicId, message: error instanceof Error ? error.message : "unknown" });
      left += 1;
    }
  }
  return { checked: stale.length, settled, expired, left };
}

// ---------------------------------------------------------------------------
// Telling the client
// ---------------------------------------------------------------------------

async function notifyClientOfOrder(
  db: Database,
  input: {
    organizationId: string;
    orderPublicId: string;
    fulfilment: "ship" | "pickup";
    buyerName: string | null;
    buyerEmail: string | null;
    totalCents: number;
    items: Array<{ name: string; unitCents: number; quantity: number }>;
    shippingAddress: ShippingAddress | null;
    portalBase: string | null;
    send: (message: EmailMessage) => Promise<SendResult>;
  },
): Promise<void> {
  const members = await db
    .select({ email: users.email, businessName: organizations.name })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(organizationMemberships.organizationId, input.organizationId), eq(users.role, "client"), eq(users.status, "active")));
  if (members.length === 0) return;

  const ordersUrl = `${input.portalBase ?? ""}/dashboard/growth/shop/orders`;
  for (const member of members) {
    try {
      const result = await input.send(
        buildNewOrderEmail({
          to: member.email,
          businessName: member.businessName,
          orderPublicId: input.orderPublicId,
          buyerName: input.buyerName,
          buyerEmail: input.buyerEmail,
          fulfilment: input.fulfilment,
          items: input.items,
          totalCents: input.totalCents,
          shippingAddress: input.shippingAddress,
          ordersUrl,
        }),
      );
      if (result.status === "failed") console.error("[shop] order email failed", { order: input.orderPublicId, error: result.error });
    } catch (error) {
      // The order is paid and recorded whatever happens to the email.
      console.error("[shop] order email threw", { order: input.orderPublicId, message: error instanceof Error ? error.message : "unknown" });
    }
  }
}
