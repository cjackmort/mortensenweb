import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { sites } from "./sites";
import { mediaAssets } from "./media";

/**
 * Shop: a client sells things from their own site.
 *
 * The portal is the system of record for the catalog — products, photos,
 * prices and stock — and the client's site reads it live through a public
 * per-site feed, the way the events page does. Money never comes here: every
 * checkout is a Stripe Checkout Session created on the client's own connected
 * account, so payouts, receipts, refunds and disputes are theirs. Stripe sees
 * line items at checkout time and nothing else; there is no catalog to sync.
 *
 * The plan of record is `docs/SHOP-PLAN.md` in the agency repository.
 */

/** Where an order is fulfilled. `pickup` collects no address at checkout. */
export const SHOP_FULFILMENTS = ["ship", "pickup"] as const;
export type ShopFulfilment = (typeof SHOP_FULFILMENTS)[number];

export const SHOP_PRODUCT_STATUSES = ["active", "hidden"] as const;
export type ShopProductStatus = (typeof SHOP_PRODUCT_STATUSES)[number];

/**
 * `pending` is a Checkout Session that exists and holds stock; `expired` is
 * one that lapsed and gave it back. Only `paid` and after are sales.
 */
export const SHOP_ORDER_STATUSES = ["pending", "paid", "shipped", "refunded", "expired"] as const;
export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];

export const SHOP_PRODUCT_ACTIONS = [
  "created",
  "updated",
  "activated",
  "hidden",
  "deleted",
  "stock_reserved",
  "stock_sold",
  "stock_released",
  "restocked",
] as const;
export type ShopProductAction = (typeof SHOP_PRODUCT_ACTIONS)[number];

/**
 * Stripe's floor for a Checkout line in USD. A product priced under it cannot
 * be bought, so the catalog refuses it rather than letting a buy button fail.
 */
export const SHOP_MIN_PRICE_CENTS = 50;

/**
 * One site's shop: where its money goes and how it ships.
 *
 * `stripe_account_id` is set by the client's own Stripe onboarding inside the
 * portal and nowhere else. There is deliberately no URL here and none in the
 * site's content: the payment destination cannot be redirected by a change
 * request, which is what keeps the agency's rule 4 ("never change where money
 * goes") automatic rather than a thing to check.
 *
 * `charges_enabled` is mirrored from Stripe's `account.updated`. Checkout is
 * refused while it is false: an account mid-onboarding would create sessions
 * that fail at payment, after the buyer has typed their card in.
 */
export const shopSettings = pgTable(
  "shop_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),

    /** The client's connected Stripe account (`acct_…`). Null until they connect. */
    stripeAccountId: text("stripe_account_id"),
    chargesEnabled: boolean("charges_enabled").notNull().default(false),
    /** ISO 4217, lower-case, as Stripe takes it. One currency per shop. */
    currency: text("currency").notNull().default("usd"),
    fulfilment: text("fulfilment").notNull().default("ship"),
    /** Flat rate per order. Ignored for pickup. */
    shippingCents: integer("shipping_cents").notNull().default(0),
    /** Stripe Tax on the session. Needs the client's origin address in Stripe. */
    taxEnabled: boolean("tax_enabled").notNull().default(false),
    /** Rendered on the site. Prefilled from a template the client edits. */
    refundPolicy: text("refund_policy"),
    shippingPolicy: text("shipping_policy"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_settings_site_key").on(t.siteId),
    index("shop_settings_org_idx").on(t.organizationId),
    check("shop_settings_currency_shape", sql`${t.currency} ~ '^[a-z]{3}$'`),
    check("shop_settings_fulfilment_known", sql`${t.fulfilment} IN ('ship', 'pickup')`),
    check("shop_settings_shipping_not_negative", sql`${t.shippingCents} >= 0`),
    check(
      "shop_settings_stripe_account_shape",
      sql`${t.stripeAccountId} IS NULL OR ${t.stripeAccountId} ~ '^acct_[A-Za-z0-9]+$'`,
    ),
  ],
);

/**
 * Something for sale.
 *
 * Stock is two counters, never one: `stock` is units on hand and not yet
 * sold, `reserved` is the part of that held by Checkout Sessions still open.
 * What a buyer can take is the difference. A session holds its units from
 * creation until it completes (both counters drop) or expires (`reserved`
 * drops). Null `stock` is unlimited and never counted. Every change to either
 * counter is one conditional UPDATE — the database refuses an oversell, and a
 * read-then-write that could race is not how any of this is written.
 *
 * A new product is `hidden`. Putting it on the site is a deliberate step, so
 * a half-filled form cannot be bought from.
 *
 * Rows are soft-deleted: an order item points at the product it was, and the
 * audit trail has to stay readable after the client removes something.
 */
export const shopProducts = pgTable(
  "shop_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    /** The product's path on the site. Unique per site among live products. */
    slug: text("slug").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    /** Units on hand. Null is unlimited. */
    stock: integer("stock"),
    /** Units held by open Checkout Sessions. Always within `stock`. */
    reserved: integer("reserved").notNull().default(0),
    status: text("status").notNull().default("hidden"),
    sortOrder: integer("sort_order").notNull().default(0),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_products_public_id_key").on(t.publicId),
    uniqueIndex("shop_products_site_slug_key")
      .on(t.siteId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    index("shop_products_site_status_idx").on(t.siteId, t.status, t.sortOrder),
    index("shop_products_org_idx").on(t.organizationId),
    check("shop_products_name_present", sql`length(trim(${t.name})) > 0`),
    check("shop_products_slug_shape", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("shop_products_price_sellable", sql`${t.priceCents} >= ${SHOP_MIN_PRICE_CENTS}`),
    check("shop_products_status_known", sql`${t.status} IN ('active', 'hidden')`),
    check("shop_products_stock_not_negative", sql`${t.stock} IS NULL OR ${t.stock} >= 0`),
    check("shop_products_reserved_not_negative", sql`${t.reserved} >= 0`),
    check(
      "shop_products_reserved_within_stock",
      sql`${t.stock} IS NULL OR ${t.reserved} <= ${t.stock}`,
    ),
  ],
);

/**
 * A product's photos, from the client's media library, in display order.
 * The first is the one the grid shows.
 */
export const shopProductImages = pgTable(
  "shop_product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_product_images_product_asset_key").on(t.productId, t.assetId),
    index("shop_product_images_asset_idx").on(t.assetId),
    check("shop_product_images_position_not_negative", sql`${t.position} >= 0`),
  ],
);

/**
 * A Checkout Session and what became of it.
 *
 * Written when the session is created, not when it is paid: the row is the
 * ledger of what stock a session holds, which is what `checkout.session.expired`
 * needs to give it back. Buyer details arrive with `checkout.session.completed`
 * and are null before it.
 *
 * `stripe_account_id` is copied from the shop's settings at creation. It is
 * which account took the money, and stays true if the client reconnects.
 *
 * Money is never implied: `paid` is set by Stripe's webhook and nothing else.
 */
export const shopOrders = pgTable(
  "shop_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),

    stripeAccountId: text("stripe_account_id").notNull(),
    stripeSessionId: text("stripe_session_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    status: text("status").notNull().default("pending"),
    fulfilment: text("fulfilment").notNull(),

    buyerName: text("buyer_name"),
    buyerEmail: text("buyer_email"),
    /** Stripe's address object, as collected. Null for pickup. */
    shippingAddress: jsonb("shipping_address"),

    subtotalCents: integer("subtotal_cents").notNull(),
    shippingCents: integer("shipping_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    currency: text("currency").notNull().default("usd"),

    /** When Stripe will expire the session; the reservation lasts until then. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_orders_public_id_key").on(t.publicId),
    uniqueIndex("shop_orders_stripe_session_key").on(t.stripeSessionId),
    index("shop_orders_org_created_idx").on(t.organizationId, t.createdAt),
    index("shop_orders_site_status_idx").on(t.siteId, t.status),
    check(
      "shop_orders_status_known",
      sql`${t.status} IN ('pending', 'paid', 'shipped', 'refunded', 'expired')`,
    ),
    check("shop_orders_fulfilment_known", sql`${t.fulfilment} IN ('ship', 'pickup')`),
    check("shop_orders_amounts_not_negative", sql`${t.subtotalCents} >= 0 AND ${t.shippingCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.totalCents} >= 0`),
    check("shop_orders_currency_shape", sql`${t.currency} ~ '^[a-z]{3}$'`),
    check(
      "shop_orders_paid_stamped",
      sql`${t.status} IN ('pending', 'expired') OR ${t.paidAt} IS NOT NULL`,
    ),
    check("shop_orders_shipped_stamped", sql`${t.status} <> 'shipped' OR ${t.shippedAt} IS NOT NULL`),
    check("shop_orders_refunded_stamped", sql`${t.status} <> 'refunded' OR ${t.refundedAt} IS NOT NULL`),
    check(
      "shop_orders_address_object",
      sql`${t.shippingAddress} IS NULL OR jsonb_typeof(${t.shippingAddress}) = 'object'`,
    ),
  ],
);

/**
 * One line of an order. Name and price are copied at checkout: the product
 * can be renamed, repriced or deleted afterwards and the order still says
 * what was bought for how much.
 */
export const shopOrderItems = pgTable(
  "shop_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => shopProducts.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    unitCents: integer("unit_cents").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shop_order_items_order_idx").on(t.orderId),
    index("shop_order_items_product_idx").on(t.productId),
    check("shop_order_items_unit_not_negative", sql`${t.unitCents} >= 0`),
    check("shop_order_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

/**
 * Every change to a product, by whom.
 *
 * The shop is the first thing a client edits that changes what a visitor
 * pays, with no review step in between — their money, their call — so the
 * trail is kept from the start. `actor_id` is null for changes the system
 * made (a sale, an expiry). `changes` is `{ field: { from, to } }`.
 */
export const shopProductEvents = pgTable(
  "shop_product_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    changes: jsonb("changes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shop_product_events_product_idx").on(t.productId, t.createdAt),
    check(
      "shop_product_events_action_known",
      sql`${t.action} IN ('created', 'updated', 'activated', 'hidden', 'deleted', 'stock_reserved', 'stock_sold', 'stock_released', 'restocked')`,
    ),
    check("shop_product_events_changes_object", sql`jsonb_typeof(${t.changes}) = 'object'`),
  ],
);
