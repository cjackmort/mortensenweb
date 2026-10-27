import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { shopOrderItems, shopOrders, shopProductEvents, shopProducts, shopSettings } from "@/db/schema";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/mailer";
import { isEmailAddress, replySenderAddress } from "@/lib/growth/lead-reply";
import { buildOrderShippedEmail, type ShippingAddress } from "@/lib/shop/emails";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { replyIdentity } from "./lead-replies";
import { shopSiteFor } from "./shop-settings";

/**
 * A client's orders, tenant-scoped. Only orders that were paid: a pending
 * checkout is a visitor's business until Stripe says otherwise, and an
 * expired one is nobody's.
 *
 * Two writes. "Mark shipped" records the moment and emails the buyer in the
 * business's name. "Restock" puts a refunded order's units back on the
 * shelf — a deliberate click, once per order, because a refund does not say
 * whether the goods came back saleable.
 */

export type OrderStatus = "paid" | "shipped" | "refunded";

export interface OrderLineView {
  name: string;
  unitCents: number;
  quantity: number;
  /** Null once the product is hard-deleted; soft-deleted products keep their link. */
  productPublicId: string | null;
}

export interface OrderView {
  publicId: string;
  status: OrderStatus;
  fulfilment: "ship" | "pickup";
  buyerName: string | null;
  buyerEmail: string | null;
  shippingAddress: ShippingAddress | null;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  paidAt: Date;
  shippedAt: Date | null;
  refundedAt: Date | null;
  /** Whether "Restock" has already been pressed for this order. */
  restocked: boolean;
  items: OrderLineView[];
}

export type OrderResult = { ok: true; message: string } | { ok: false; message: string };

const SHOWN_STATUSES: OrderStatus[] = ["paid", "shipped", "refunded"];

async function ownOrder(db: Database, ctx: TenantContext, publicId: string) {
  const [row] = await db
    .select()
    .from(shopOrders)
    .where(and(eq(shopOrders.publicId, publicId), eq(shopOrders.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

async function linesFor(db: Database, orderIds: string[]) {
  if (orderIds.length === 0) return [];
  return db
    .select({
      orderId: shopOrderItems.orderId,
      name: shopOrderItems.name,
      unitCents: shopOrderItems.unitCents,
      quantity: shopOrderItems.quantity,
      productId: shopOrderItems.productId,
      productPublicId: shopProducts.publicId,
    })
    .from(shopOrderItems)
    .leftJoin(shopProducts, eq(shopProducts.id, shopOrderItems.productId))
    .where(inArray(shopOrderItems.orderId, orderIds));
}

/** Orders restocked already: the `restocked` events name them. */
async function restockedOrders(db: Database, ctx: TenantContext, publicIds: string[]): Promise<Set<string>> {
  if (publicIds.length === 0) return new Set();
  const rows = await db
    .select({ order: sql<string>`${shopProductEvents.changes} ->> 'order'` })
    .from(shopProductEvents)
    .where(
      and(
        eq(shopProductEvents.organizationId, ctx.organizationId),
        eq(shopProductEvents.action, "restocked"),
        inArray(sql`${shopProductEvents.changes} ->> 'order'`, publicIds),
      ),
    );
  return new Set(rows.map((r) => r.order));
}

export async function listOrders(db: Database, ctx: TenantContext): Promise<OrderView[]> {
  const rows = await db
    .select()
    .from(shopOrders)
    .where(and(eq(shopOrders.organizationId, ctx.organizationId), inArray(shopOrders.status, SHOWN_STATUSES)))
    .orderBy(desc(shopOrders.paidAt))
    .limit(200);
  const lines = await linesFor(
    db,
    rows.map((r) => r.id),
  );
  const restocked = await restockedOrders(
    db,
    ctx,
    rows.map((r) => r.publicId),
  );

  return rows.map((row) => ({
    publicId: row.publicId,
    status: row.status as OrderStatus,
    fulfilment: row.fulfilment === "pickup" ? "pickup" : "ship",
    buyerName: row.buyerName,
    buyerEmail: row.buyerEmail,
    shippingAddress: (row.shippingAddress as ShippingAddress | null) ?? null,
    subtotalCents: row.subtotalCents,
    shippingCents: row.shippingCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    currency: row.currency,
    paidAt: row.paidAt!,
    shippedAt: row.shippedAt,
    refundedAt: row.refundedAt,
    restocked: restocked.has(row.publicId),
    items: lines
      .filter((l) => l.orderId === row.id)
      .map((l) => ({ name: l.name, unitCents: l.unitCents, quantity: l.quantity, productPublicId: l.productPublicId ?? null })),
  }));
}

/** For the hub: paid orders nobody has shipped yet. */
export async function countOrdersAwaitingShipment(db: Database, ctx: TenantContext): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopOrders)
    .where(and(eq(shopOrders.organizationId, ctx.organizationId), eq(shopOrders.status, "paid")));
  return row?.count ?? 0;
}

/**
 * The order is on its way. Recorded first, emailed second: a buyer told
 * twice is a nuisance, a shipment the portal forgot is a dispute.
 */
export async function markOrderShipped(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  options: { send?: (message: EmailMessage) => Promise<SendResult>; now?: Date } = {},
): Promise<OrderResult> {
  assertMutable(ctx);
  const order = await ownOrder(db, ctx, publicId);
  if (order.status !== "paid") {
    return { ok: false, message: order.status === "shipped" ? "Already marked as shipped." : "Only a paid order can be marked shipped." };
  }

  const now = options.now ?? new Date();
  const claimed = await db
    .update(shopOrders)
    .set({ status: "shipped", shippedAt: now, updatedAt: now })
    .where(and(eq(shopOrders.id, order.id), eq(shopOrders.status, "paid")))
    .returning({ id: shopOrders.id });
  if (claimed.length === 0) return { ok: false, message: "Already marked as shipped." };

  const done = order.fulfilment === "pickup" ? "Marked as collected." : "Marked as shipped.";
  if (!isEmailAddress(order.buyerEmail)) return { ok: true, message: `${done} No email address came with the order, so nobody was emailed.` };

  const sender = replySenderAddress();
  if (!sender) return { ok: true, message: `${done} Email is not set up here, so the customer was not emailed.` };

  const [identity, items, site] = await Promise.all([replyIdentity(db, ctx), linesFor(db, [order.id]), shopSiteFor(db, ctx)]);
  const [settings] = site ? await db.select({ shippingPolicy: shopSettings.shippingPolicy }).from(shopSettings).where(eq(shopSettings.siteId, site.id)).limit(1) : [];
  const message = buildOrderShippedEmail({
    to: order.buyerEmail,
    businessName: identity.businessName,
    senderAddress: sender,
    replyTo: identity.replyTo,
    orderPublicId: order.publicId,
    items: items.map((i) => ({ name: i.name, unitCents: i.unitCents, quantity: i.quantity })),
    shippingAddress: (order.shippingAddress as ShippingAddress | null) ?? null,
    shippingPolicy: settings?.shippingPolicy ?? null,
  });
  const result = await (options.send ?? sendEmail)(message);
  if (result.status === "sent") return { ok: true, message: `${done} The customer has been emailed.` };
  if (result.status === "skipped") return { ok: true, message: `${done} Email is not set up here, so the customer was not emailed.` };
  console.error("[shop] shipped email failed", { order: order.publicId, error: result.error });
  return { ok: true, message: `${done} The email to the customer did not go through; you may want to tell them yourself.` };
}

/** Put a refunded order's units back on the shelf. Once. */
export async function restockOrder(db: Database, ctx: TenantContext, publicId: string): Promise<OrderResult> {
  assertMutable(ctx);
  const order = await ownOrder(db, ctx, publicId);
  if (order.status !== "refunded") return { ok: false, message: "Only a refunded order can be restocked." };
  if ((await restockedOrders(db, ctx, [order.publicId])).has(order.publicId)) return { ok: false, message: "Already restocked." };

  const lines = await linesFor(db, [order.id]);
  let units = 0;
  for (const line of lines) {
    if (!line.productId) continue;
    const [product] = await db
      .select({ id: shopProducts.id, stock: shopProducts.stock })
      .from(shopProducts)
      .where(and(eq(shopProducts.id, line.productId), eq(shopProducts.organizationId, ctx.organizationId)))
      .limit(1);
    if (!product) continue;
    if (product.stock !== null) {
      await db
        .update(shopProducts)
        .set({ stock: sql`${shopProducts.stock} + ${line.quantity}`, updatedAt: new Date() })
        .where(eq(shopProducts.id, product.id));
      units += line.quantity;
    }
    await db.insert(shopProductEvents).values({
      productId: product.id,
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "restocked",
      changes: { order: order.publicId, quantity: line.quantity, counted: product.stock !== null },
    });
  }
  return { ok: true, message: units === 0 ? "Restocked. Nothing was counted, since stock on those products is unlimited." : `Restocked ${units} ${units === 1 ? "unit" : "units"}.` };
}
