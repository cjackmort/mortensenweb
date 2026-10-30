import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import { shopOrderItems, shopOrders, shopProducts, shopSettings, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { itemsLabel, monthStart, salesWindowStart, summariseSales, type SaleRow } from "@/lib/shop/sales";
import { getShopSales } from "@/db/repositories/client/shop-sales";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * "See their sales": what a store client reads on the shop page.
 *
 * What would go wrong quietly: a refunded order counted as money taken; an
 * unpaid checkout counted as a sale; a sale on the evening of the 30th put in
 * the next month because the server counts in UTC; another client's orders
 * in the figures.
 */

const DENVER = "America/Denver";
// 2026-10-29, noon in Denver.
const NOW = new Date("2026-10-29T18:00:00Z");

describe("the month, in the client's time zone", () => {
  it("starts at local midnight on the 1st, through daylight saving changes", () => {
    expect(monthStart(NOW, DENVER).toISOString()).toBe("2026-10-01T06:00:00.000Z");
    // Clocks go back on 1 November 2026, after midnight: still daylight time.
    expect(monthStart(new Date("2026-11-15T12:00:00Z"), DENVER).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(monthStart(new Date("2026-03-20T12:00:00Z"), DENVER).toISOString()).toBe("2026-03-01T07:00:00.000Z");
  });

  it("is the local month, not the UTC one, late on the last evening", () => {
    // 31 October, 8pm in Denver, is already 1 November in UTC.
    expect(monthStart(new Date("2026-11-01T02:00:00Z"), DENVER).toISOString()).toBe("2026-10-01T06:00:00.000Z");
  });

  it("reads back far enough for both the month and the last 30 days", () => {
    expect(salesWindowStart(NOW, DENVER).toISOString()).toBe("2026-09-29T18:00:00.000Z");
    // On the 31st the month reaches back further than 30 days.
    const late = new Date("2026-10-31T18:00:00Z");
    expect(salesWindowStart(late, DENVER).toISOString()).toBe("2026-10-01T06:00:00.000Z");
  });
});

describe("summing the sales", () => {
  const rows: SaleRow[] = [
    { status: "paid", totalCents: 5000, units: 1, paidAt: new Date("2026-10-28T15:00:00Z") },
    // 1 October, 1am in Denver: this month.
    { status: "shipped", totalCents: 3000, units: 2, paidAt: new Date("2026-10-01T07:00:00Z") },
    // 30 September, 11pm in Denver: last month, but inside 30 days.
    { status: "paid", totalCents: 2000, units: 1, paidAt: new Date("2026-10-01T05:00:00Z") },
    { status: "refunded", totalCents: 4000, units: 3, paidAt: new Date("2026-10-10T15:00:00Z") },
    // Older than 30 days and last month: in neither.
    { status: "shipped", totalCents: 10000, units: 5, paidAt: new Date("2026-09-15T15:00:00Z") },
  ];

  it("counts paid and sent orders as sales, and leaves refunded ones out", () => {
    const { thisMonth, last30Days } = summariseSales(rows, NOW, DENVER);
    expect(thisMonth).toEqual({ salesCents: 8000, orders: 2, units: 3, refundedOrders: 1, refundedCents: 4000 });
    expect(last30Days).toEqual({ salesCents: 10000, orders: 3, units: 4, refundedOrders: 1, refundedCents: 4000 });
  });

  it("is all zeros with nothing sold", () => {
    expect(summariseSales([], NOW, DENVER).thisMonth).toEqual({
      salesCents: 0,
      orders: 0,
      units: 0,
      refundedOrders: 0,
      refundedCents: 0,
    });
  });
});

describe("an order in one line", () => {
  it("names what was bought, and how many", () => {
    expect(itemsLabel([{ name: "Mug", quantity: 2 }])).toBe("2 × Mug");
    expect(itemsLabel([{ name: "Mug", quantity: 1 }, { name: "Bowl", quantity: 1 }])).toBe("Mug, Bowl");
    expect(
      itemsLabel([
        { name: "Mug", quantity: 2 },
        { name: "Bowl", quantity: 1 },
        { name: "Vase", quantity: 1 },
        { name: "Plate", quantity: 4 },
      ]),
    ).toBe("2 × Mug, Bowl and 2 more");
    expect(itemsLabel([])).toBe("No items recorded");
  });
});

describe("a store's sales, from the database", () => {
  let db: Database;
  let close: () => Promise<void>;
  let acme: SeededTenant;
  let globex: SeededTenant;
  let empty: SeededTenant;

  async function shop(tenant: SeededTenant) {
    const [site] = await db
      .insert(sites)
      .values({ publicId: newPublicId(), organizationId: tenant.organizationId, name: `site-${newPublicId().slice(0, 6).toLowerCase()}`, status: "live" })
      .returning({ id: sites.id });
    await db.insert(shopSettings).values({ organizationId: tenant.organizationId, siteId: site!.id, stripeAccountId: "acct_test", chargesEnabled: true });
    return site!.id;
  }

  async function product(tenant: SeededTenant, siteId: string, name: string) {
    const [row] = await db
      .insert(shopProducts)
      .values({
        publicId: newPublicId(),
        organizationId: tenant.organizationId,
        siteId,
        name,
        slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${newPublicId().slice(0, 4).toLowerCase()}`,
        priceCents: 2500,
        status: "active",
      })
      .returning({ id: shopProducts.id, publicId: shopProducts.publicId });
    return row!;
  }

  async function order(
    tenant: SeededTenant,
    siteId: string,
    status: "pending" | "paid" | "shipped" | "refunded" | "expired",
    paidAt: Date | null,
    lines: Array<{ productId: string | null; name: string; unitCents: number; quantity: number }>,
    buyerName = "A buyer",
  ) {
    const subtotal = lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
    const publicId = newPublicId();
    const [row] = await db
      .insert(shopOrders)
      .values({
        publicId,
        organizationId: tenant.organizationId,
        siteId,
        stripeAccountId: "acct_test",
        stripeSessionId: `cs_${publicId}`,
        status,
        fulfilment: "ship",
        buyerName,
        subtotalCents: subtotal,
        shippingCents: 500,
        totalCents: subtotal + 500,
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        paidAt,
        shippedAt: status === "shipped" ? paidAt : null,
        refundedAt: status === "refunded" ? paidAt : null,
      })
      .returning({ id: shopOrders.id });
    await db.insert(shopOrderItems).values(lines.map((l) => ({ orderId: row!.id, ...l })));
    return publicId;
  }

  const day = (iso: string) => new Date(`${iso}T15:00:00Z`);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    acme = await seedTenant(db, "Acme Pottery");
    globex = await seedTenant(db, "Globex Glass");
    empty = await seedTenant(db, "Empty Shop");
    vi.stubEnv("BUSINESS_TIMEZONE", DENVER);

    const site = await shop(acme);
    const mug = await product(acme, site, "Mug");
    const bowl = await product(acme, site, "Bowl");
    await order(acme, site, "paid", day("2026-10-28"), [{ productId: mug.id, name: "Mug", unitCents: 2500, quantity: 2 }], "Newest");
    await order(acme, site, "shipped", day("2026-10-20"), [
      { productId: mug.id, name: "Mug", unitCents: 2500, quantity: 1 },
      { productId: bowl.id, name: "Bowl", unitCents: 4000, quantity: 1 },
    ]);
    await order(acme, site, "refunded", day("2026-10-15"), [{ productId: bowl.id, name: "Bowl", unitCents: 4000, quantity: 5 }]);
    // A product deleted outright: its line keeps the name.
    await order(acme, site, "shipped", day("2026-08-01"), [{ productId: null, name: "Old teapot", unitCents: 9000, quantity: 1 }]);
    await order(acme, site, "pending", null, [{ productId: mug.id, name: "Mug", unitCents: 2500, quantity: 9 }]);
    await order(acme, site, "expired", null, [{ productId: bowl.id, name: "Bowl", unitCents: 4000, quantity: 9 }]);

    const otherSite = await shop(globex);
    const vase = await product(globex, otherSite, "Vase");
    await order(globex, otherSite, "paid", day("2026-10-27"), [{ productId: vase.id, name: "Vase", unitCents: 99900, quantity: 1 }]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await close();
  });

  it("sums only this client's paid orders", async () => {
    const view = await getShopSales(db, acme.ctx, { now: NOW });
    expect(view.everSold).toBe(true);
    expect(view.timeZone).toBe(DENVER);
    // 2 mugs + $5 shipping, and a mug, a bowl + $5 shipping.
    expect(view.summary.thisMonth).toEqual({ salesCents: 5500 + 7000, orders: 2, units: 4, refundedOrders: 1, refundedCents: 20500 });
  });

  it("ranks best sellers by units sold, then money, never counting refunds or unpaid checkouts", async () => {
    const view = await getShopSales(db, acme.ctx, { now: NOW });
    expect(view.bestSellers.map((b) => [b.name, b.units, b.salesCents])).toEqual([
      ["Mug", 3, 7500],
      ["Old teapot", 1, 9000],
      ["Bowl", 1, 4000],
    ]);
    expect(view.bestSellers[0]!.productPublicId).not.toBeNull();
    expect(view.bestSellers[1]!.productPublicId).toBeNull();
  });

  it("lists recent orders newest first, refunds included and marked", async () => {
    const view = await getShopSales(db, acme.ctx, { now: NOW });
    expect(view.recent.map((r) => r.status)).toEqual(["paid", "shipped", "refunded", "shipped"]);
    expect(view.recent[0]).toMatchObject({ buyerName: "Newest", totalCents: 5500, items: [{ name: "Mug", quantity: 2 }] });
  });

  it("tells a shop with no sales apart from one with a quiet month", async () => {
    const view = await getShopSales(db, empty.ctx, { now: NOW });
    expect(view.everSold).toBe(false);
    expect(view.bestSellers).toEqual([]);
    expect(view.recent).toEqual([]);
  });
});
