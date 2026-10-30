import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { organizations, shopOrderItems, shopOrders, shopProducts } from "@/db/schema";
import { salesWindowStart, summariseSales, type SaleStatus, type SalesSummary } from "@/lib/shop/sales";
import { businessTimeZone } from "@/lib/time";
import type { TenantContext } from "../context";

/**
 * "See their sales": the figures at the top of a store client's shop page.
 *
 * Read-only and tenant-scoped like the rest of the shop. What counts as a
 * sale, and how refunds are treated, is decided in `lib/shop/sales.ts`;
 * this reads the rows. A pending checkout is a visitor's business and an
 * expired one is nobody's, so neither is read.
 */

const SALE_STATUSES: SaleStatus[] = ["paid", "shipped", "refunded"];
/** Orders that stand: paid, and not refunded since. */
const STANDING: SaleStatus[] = ["paid", "shipped"];

const BEST_SELLERS = 5;
const RECENT_ORDERS = 5;

export interface BestSeller {
  /** Null when the product is deleted: the name is still worth showing, the link is not. */
  productPublicId: string | null;
  name: string;
  units: number;
  salesCents: number;
}

export interface RecentOrder {
  publicId: string;
  status: SaleStatus;
  fulfilment: "ship" | "pickup";
  buyerName: string | null;
  totalCents: number;
  paidAt: Date;
  items: Array<{ name: string; quantity: number }>;
}

export interface ShopSalesView {
  summary: SalesSummary;
  /**
   * Whether any order was ever paid. Tells a shop that has not sold yet
   * (which gets a sentence, not a row of $0.00) from one having a quiet
   * month (where $0.00 is the true figure).
   */
  everSold: boolean;
  /** All time, by units sold. */
  bestSellers: BestSeller[];
  recent: RecentOrder[];
  /** The client's own, so "this month" starts on their 1st, not UTC's. */
  timeZone: string;
}

async function timeZoneFor(db: Database, ctx: TenantContext): Promise<string> {
  const [row] = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  return row?.timezone ?? businessTimeZone();
}

async function windowRows(db: Database, ctx: TenantContext, since: Date) {
  const rows = await db
    .select({
      status: shopOrders.status,
      totalCents: shopOrders.totalCents,
      paidAt: shopOrders.paidAt,
      units: sql<number>`coalesce(sum(${shopOrderItems.quantity}), 0)::int`,
    })
    .from(shopOrders)
    .leftJoin(shopOrderItems, eq(shopOrderItems.orderId, shopOrders.id))
    .where(
      and(
        eq(shopOrders.organizationId, ctx.organizationId),
        inArray(shopOrders.status, SALE_STATUSES),
        gte(shopOrders.paidAt, since),
      ),
    )
    .groupBy(shopOrders.id);
  return rows.map((row) => ({
    status: row.status as SaleStatus,
    totalCents: row.totalCents,
    units: Number(row.units),
    // Every sale status is stamped with paid_at (`shop_orders_paid_stamped`).
    paidAt: row.paidAt!,
  }));
}

async function bestSellers(db: Database, ctx: TenantContext): Promise<BestSeller[]> {
  const units = sql<number>`sum(${shopOrderItems.quantity})::int`;
  const salesCents = sql<number>`sum(${shopOrderItems.quantity} * ${shopOrderItems.unitCents})::int`;
  // A line whose product was deleted outright has no product to group by;
  // its own name stands in, so two deleted products stay two rows.
  const orphanName = sql`case when ${shopOrderItems.productId} is null then ${shopOrderItems.name} end`;

  const rows = await db
    .select({
      productPublicId: sql<string | null>`max(case when ${shopProducts.deletedAt} is null then ${shopProducts.publicId} end)`,
      // The product's name today, so a rename does not split it in two.
      name: sql<string>`coalesce(max(${shopProducts.name}), max(${shopOrderItems.name}))`,
      units,
      salesCents,
    })
    .from(shopOrderItems)
    .innerJoin(shopOrders, eq(shopOrders.id, shopOrderItems.orderId))
    .leftJoin(shopProducts, eq(shopProducts.id, shopOrderItems.productId))
    .where(and(eq(shopOrders.organizationId, ctx.organizationId), inArray(shopOrders.status, STANDING)))
    .groupBy(shopOrderItems.productId, orphanName)
    .orderBy(desc(units), desc(salesCents), asc(sql`2`))
    .limit(BEST_SELLERS);

  return rows.map((row) => ({
    productPublicId: row.productPublicId,
    name: row.name,
    units: Number(row.units),
    salesCents: Number(row.salesCents),
  }));
}

async function recentOrders(db: Database, ctx: TenantContext): Promise<RecentOrder[]> {
  const rows = await db
    .select({
      id: shopOrders.id,
      publicId: shopOrders.publicId,
      status: shopOrders.status,
      fulfilment: shopOrders.fulfilment,
      buyerName: shopOrders.buyerName,
      totalCents: shopOrders.totalCents,
      paidAt: shopOrders.paidAt,
    })
    .from(shopOrders)
    .where(and(eq(shopOrders.organizationId, ctx.organizationId), inArray(shopOrders.status, SALE_STATUSES)))
    .orderBy(desc(shopOrders.paidAt))
    .limit(RECENT_ORDERS);
  if (rows.length === 0) return [];

  const lines = await db
    .select({ orderId: shopOrderItems.orderId, name: shopOrderItems.name, quantity: shopOrderItems.quantity })
    .from(shopOrderItems)
    .where(
      inArray(
        shopOrderItems.orderId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(shopOrderItems.createdAt));

  return rows.map((row) => ({
    publicId: row.publicId,
    status: row.status as SaleStatus,
    fulfilment: row.fulfilment === "pickup" ? "pickup" : "ship",
    buyerName: row.buyerName,
    totalCents: row.totalCents,
    paidAt: row.paidAt!,
    items: lines.filter((line) => line.orderId === row.id).map((line) => ({ name: line.name, quantity: line.quantity })),
  }));
}

export async function getShopSales(
  db: Database,
  ctx: TenantContext,
  options: { now?: Date } = {},
): Promise<ShopSalesView> {
  const now = options.now ?? new Date();
  const timeZone = await timeZoneFor(db, ctx);
  const [rows, best, recent] = await Promise.all([
    windowRows(db, ctx, salesWindowStart(now, timeZone)),
    bestSellers(db, ctx),
    recentOrders(db, ctx),
  ]);

  return {
    summary: summariseSales(rows, now, timeZone),
    everSold: recent.length > 0,
    bestSellers: best,
    recent,
    timeZone,
  };
}
