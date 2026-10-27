import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  shopOrderItems,
  shopOrders,
  shopProductEvents,
  shopProducts,
  shopSettings,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Migration 0038 on its own: the tables exist as the TypeScript schema
 * declares them, and the database refuses the rows the application must
 * never write — whatever code path tries. The stock invariant matters most:
 * a product can never hold more units for open checkouts than it has.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let siteId: string;

async function newSite(): Promise<string> {
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: acme.organizationId, name: `acme-${newPublicId().slice(0, 6).toLowerCase()}` })
    .returning({ id: sites.id });
  return site!.id;
}

function productRow(overrides: Partial<typeof shopProducts.$inferInsert> = {}) {
  return {
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    siteId,
    name: "Small cast fish",
    slug: `small-cast-fish-${newPublicId().slice(0, 6).toLowerCase()}`,
    priceCents: 15000,
    ...overrides,
  };
}

function orderRow(overrides: Partial<typeof shopOrders.$inferInsert> = {}) {
  return {
    publicId: newPublicId(),
    organizationId: acme.organizationId,
    siteId,
    stripeAccountId: "acct_1Test",
    stripeSessionId: `cs_test_${newPublicId()}`,
    fulfilment: "ship",
    subtotalCents: 15000,
    totalCents: 15000,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    ...overrides,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  siteId = await newSite();
});

afterAll(async () => {
  await close();
});

describe("shop_settings", () => {
  it("starts with checkout off and shipping as the default fulfilment", async () => {
    const [row] = await db
      .insert(shopSettings)
      .values({ organizationId: acme.organizationId, siteId: await newSite() })
      .returning();
    expect(row!.stripeAccountId).toBeNull();
    expect(row!.chargesEnabled).toBe(false);
    expect(row!.fulfilment).toBe("ship");
    expect(row!.shippingCents).toBe(0);
    expect(row!.currency).toBe("usd");
  });

  it("allows one shop per site", async () => {
    const site = await newSite();
    await db.insert(shopSettings).values({ organizationId: acme.organizationId, siteId: site });
    await expect(
      db.insert(shopSettings).values({ organizationId: acme.organizationId, siteId: site }),
    ).rejects.toThrow();
  });

  it("refuses a payment destination that is not a Stripe account id", async () => {
    await expect(
      db.insert(shopSettings).values({
        organizationId: acme.organizationId,
        siteId: await newSite(),
        stripeAccountId: "https://buy.stripe.com/elsewhere",
      }),
    ).rejects.toThrow();
  });

  it("refuses a negative shipping rate and an unknown fulfilment", async () => {
    await expect(
      db.insert(shopSettings).values({ organizationId: acme.organizationId, siteId: await newSite(), shippingCents: -1 }),
    ).rejects.toThrow();
    await expect(
      db.insert(shopSettings).values({ organizationId: acme.organizationId, siteId: await newSite(), fulfilment: "courier" }),
    ).rejects.toThrow();
  });
});

describe("shop_products", () => {
  it("is hidden until the client puts it on the site, with unlimited stock by default", async () => {
    const [row] = await db.insert(shopProducts).values(productRow()).returning();
    expect(row!.status).toBe("hidden");
    expect(row!.stock).toBeNull();
    expect(row!.reserved).toBe(0);
    expect(row!.deletedAt).toBeNull();
  });

  it("refuses a price Stripe could not charge", async () => {
    await expect(db.insert(shopProducts).values(productRow({ priceCents: 49 }))).rejects.toThrow();
    await expect(db.insert(shopProducts).values(productRow({ priceCents: 0 }))).rejects.toThrow();
  });

  it("refuses a blank name and a slug that is not a URL path segment", async () => {
    await expect(db.insert(shopProducts).values(productRow({ name: "   " }))).rejects.toThrow();
    await expect(db.insert(shopProducts).values(productRow({ slug: "Has Caps" }))).rejects.toThrow();
    await expect(db.insert(shopProducts).values(productRow({ slug: "-leading" }))).rejects.toThrow();
  });

  it("refuses two live products on one site with the same slug, but not after one is removed", async () => {
    const [first] = await db.insert(shopProducts).values(productRow({ slug: "trout" })).returning({ id: shopProducts.id });
    await expect(db.insert(shopProducts).values(productRow({ slug: "trout" }))).rejects.toThrow();

    await db.update(shopProducts).set({ deletedAt: new Date() }).where(eq(shopProducts.id, first!.id));
    await expect(db.insert(shopProducts).values(productRow({ slug: "trout" }))).resolves.toBeDefined();
  });

  it("allows the same slug on a different site", async () => {
    await db.insert(shopProducts).values(productRow({ slug: "buddha" }));
    await expect(
      db.insert(shopProducts).values(productRow({ slug: "buddha", siteId: await newSite() })),
    ).resolves.toBeDefined();
  });

  it("never holds more units for open checkouts than it has", async () => {
    await expect(db.insert(shopProducts).values(productRow({ stock: 1, reserved: 2 }))).rejects.toThrow();
    await expect(db.insert(shopProducts).values(productRow({ stock: -1 }))).rejects.toThrow();
    await expect(db.insert(shopProducts).values(productRow({ reserved: -1 }))).rejects.toThrow();

    const [oneOff] = await db.insert(shopProducts).values(productRow({ stock: 1, reserved: 1 })).returning();
    expect(oneOff!.stock).toBe(1);
    await expect(
      db.update(shopProducts).set({ reserved: 2 }).where(eq(shopProducts.id, oneOff!.id)),
    ).rejects.toThrow();
  });

  it("counts nothing against unlimited stock", async () => {
    await expect(db.insert(shopProducts).values(productRow({ stock: null, reserved: 5 }))).resolves.toBeDefined();
  });

  it("refuses a status the shop does not have", async () => {
    await expect(db.insert(shopProducts).values(productRow({ status: "draft" }))).rejects.toThrow();
  });
});

describe("shop_orders", () => {
  it("starts pending, with no buyer, as the record of what a session holds", async () => {
    const [row] = await db.insert(shopOrders).values(orderRow()).returning();
    expect(row!.status).toBe("pending");
    expect(row!.buyerEmail).toBeNull();
    expect(row!.paidAt).toBeNull();
  });

  it("refuses the same Checkout Session twice", async () => {
    const sessionId = `cs_test_${newPublicId()}`;
    await db.insert(shopOrders).values(orderRow({ stripeSessionId: sessionId }));
    await expect(db.insert(shopOrders).values(orderRow({ stripeSessionId: sessionId }))).rejects.toThrow();
  });

  it("will not call an order paid, shipped or refunded without the moment it happened", async () => {
    await expect(db.insert(shopOrders).values(orderRow({ status: "paid" }))).rejects.toThrow();
    await expect(
      db.insert(shopOrders).values(orderRow({ status: "shipped", paidAt: new Date() })),
    ).rejects.toThrow();
    await expect(
      db.insert(shopOrders).values(orderRow({ status: "refunded", paidAt: new Date() })),
    ).rejects.toThrow();
    await expect(
      db.insert(shopOrders).values(orderRow({ status: "paid", paidAt: new Date() })),
    ).resolves.toBeDefined();
  });

  it("refuses negative money and an address that is not an object", async () => {
    await expect(db.insert(shopOrders).values(orderRow({ totalCents: -1 }))).rejects.toThrow();
    await expect(db.insert(shopOrders).values(orderRow({ shippingAddress: ["line1"] }))).rejects.toThrow();
  });

  it("refuses a line with nothing in it", async () => {
    const [order] = await db.insert(shopOrders).values(orderRow()).returning({ id: shopOrders.id });
    await expect(
      db.insert(shopOrderItems).values({ orderId: order!.id, name: "Small cast fish", unitCents: 15000, quantity: 0 }),
    ).rejects.toThrow();
    await expect(
      db.insert(shopOrderItems).values({ orderId: order!.id, name: "Small cast fish", unitCents: 15000, quantity: 1 }),
    ).resolves.toBeDefined();
  });

  it("keeps the line after the product is gone", async () => {
    const [product] = await db.insert(shopProducts).values(productRow()).returning({ id: shopProducts.id });
    const [order] = await db.insert(shopOrders).values(orderRow()).returning({ id: shopOrders.id });
    await db.insert(shopOrderItems).values({
      orderId: order!.id,
      productId: product!.id,
      name: "Small cast fish",
      unitCents: 15000,
      quantity: 1,
    });

    await db.delete(shopProducts).where(eq(shopProducts.id, product!.id));

    const [line] = await db.select().from(shopOrderItems).where(eq(shopOrderItems.orderId, order!.id));
    expect(line!.productId).toBeNull();
    expect(line!.name).toBe("Small cast fish");
  });
});

describe("shop_product_events", () => {
  it("refuses an action it does not know and changes that are not an object", async () => {
    const [product] = await db.insert(shopProducts).values(productRow()).returning({ id: shopProducts.id });
    await expect(
      db.insert(shopProductEvents).values({ productId: product!.id, organizationId: acme.organizationId, action: "glanced_at" }),
    ).rejects.toThrow();
    await expect(
      db.insert(shopProductEvents).values({
        productId: product!.id,
        organizationId: acme.organizationId,
        action: "updated",
        changes: ["price"],
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(shopProductEvents).values({
        productId: product!.id,
        organizationId: acme.organizationId,
        action: "updated",
        changes: { priceCents: { from: 15000, to: 16000 } },
      }),
    ).resolves.toBeDefined();
  });

  it("goes with the product when a row is hard-deleted", async () => {
    const [product] = await db.insert(shopProducts).values(productRow()).returning({ id: shopProducts.id });
    await db.insert(shopProductEvents).values({ productId: product!.id, organizationId: acme.organizationId, action: "created" });
    await db.delete(shopProducts).where(eq(shopProducts.id, product!.id));
    const rows = await db.select().from(shopProductEvents).where(eq(shopProductEvents.productId, product!.id));
    expect(rows).toHaveLength(0);
  });
});
