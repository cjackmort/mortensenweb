import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import type { EmailMessage } from "@/lib/email/mailer";
import { mediaAssets, mediaDerivatives, shopOrders, shopProductEvents, shopProductImages, shopProducts, shopSettings, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { checkoutReturnUrls, parseCheckoutRequest, returnBase, siteOrigins } from "@/lib/shop/public";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Money through a client's shop, with no session on either end.
 *
 * What would go wrong quietly: two buyers getting the last piece; a unit
 * held for ever by a checkout nobody finished; a paid session counted twice,
 * or a lost webhook turning a sale into a release; a buyer sent back to a
 * page that is not the client's; a refund quietly putting damaged goods back
 * on sale; and a product another client hid showing up in a feed.
 */

const stripeState = {
  created: [] as Array<{ params: Stripe.Checkout.SessionCreateParams; options: { stripeAccount?: string; idempotencyKey?: string } }>,
  sessions: new Map<string, Stripe.Checkout.Session>(),
  failNext: false,
};

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  return {
    ...actual,
    requireStripe: () =>
      ({
        checkout: {
          sessions: {
            create: async (params: Stripe.Checkout.SessionCreateParams, options: { stripeAccount?: string; idempotencyKey?: string }) => {
              if (stripeState.failNext) {
                stripeState.failNext = false;
                throw new Error("stripe is down");
              }
              stripeState.created.push({ params, options });
              const id = `cs_test_${stripeState.created.length}`;
              const session = { id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid" } as Stripe.Checkout.Session;
              stripeState.sessions.set(id, session);
              return session;
            },
            retrieve: async (id: string) => {
              const found = stripeState.sessions.get(id);
              if (!found) throw new Error(`no such session ${id}`);
              return found;
            },
          },
        },
      }) as never,
  };
});

const { beginShopCheckout, expireCheckoutSession, reconcileStaleCheckouts, recordShopRefund, settleCheckoutSession } = await import(
  "@/db/repositories/admin/shop-checkout"
);
const { findProductImage, listShopForSite } = await import("@/db/repositories/admin/shop-public");
const { listOrders, markOrderShipped, restockOrder, countOrdersAwaitingShipment } = await import("@/db/repositories/client/shop-orders");

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;
let sitePublicId: string;
let siteId: string;
let fish: { id: string; publicId: string };
let trout: { id: string; publicId: string };
let hidden: { id: string; publicId: string };
let fishAssetId: string;

const imageUrl = (p: string, i: number) => `https://portal.example.test/img/${p}/${i}`;

async function product(name: string, overrides: Partial<typeof shopProducts.$inferInsert> = {}) {
  const [row] = await db
    .insert(shopProducts)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      siteId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${newPublicId().slice(0, 4).toLowerCase()}`,
      priceCents: 15000,
      status: "active",
      ...overrides,
    })
    .returning({ id: shopProducts.id, publicId: shopProducts.publicId });
  return row!;
}

async function productRow(id: string) {
  const [row] = await db.select({ stock: shopProducts.stock, reserved: shopProducts.reserved }).from(shopProducts).where(eq(shopProducts.id, id));
  return row!;
}

async function orderRow(publicId: string) {
  const [row] = await db.select().from(shopOrders).where(eq(shopOrders.publicId, publicId));
  return row!;
}

async function eventsFor(productId: string) {
  return (await db.select({ action: shopProductEvents.action, changes: shopProductEvents.changes }).from(shopProductEvents).where(eq(shopProductEvents.productId, productId))).map(
    (e) => e.action,
  );
}

function paidSession(id: string, overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    payment_intent: `pi_${id}`,
    customer_details: { name: "Dana Reyes", email: "dana@example.test" },
    collected_information: {
      shipping_details: { name: "Dana Reyes", address: { line1: "1 Main St", line2: null, city: "Riverton", state: "UT", postal_code: "84065", country: "US" } },
    },
    amount_subtotal: 15000,
    amount_total: 15850,
    total_details: { amount_discount: 0, amount_shipping: 850, amount_tax: 0 },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");

  sitePublicId = newPublicId();
  const [site] = await db
    .insert(sites)
    .values({ publicId: sitePublicId, organizationId: acme.organizationId, name: "Acme", primaryDomain: "acme.example", status: "live" })
    .returning({ id: sites.id });
  siteId = site!.id;
  await db.insert(shopSettings).values({
    organizationId: acme.organizationId,
    siteId,
    stripeAccountId: "acct_acme",
    chargesEnabled: true,
    fulfilment: "ship",
    shippingCents: 850,
    shippingPolicy: "Orders go out within 3 working days.",
  });

  fish = await product("Small cast fish", { stock: 1 });
  trout = await product("Trout print", { stock: null, priceCents: 4000 });
  hidden = await product("Hidden piece", { status: "hidden" });

  fishAssetId = newPublicId();
  const [asset] = await db
    .insert(mediaAssets)
    .values({
      publicId: fishAssetId,
      organizationId: acme.organizationId,
      status: "ready",
      storageKey: `media/${fishAssetId}`,
      originalFilename: "fish.jpg",
      contentType: "image/jpeg",
      byteSize: 1000,
      checksumSha256: "0".repeat(64),
    })
    .returning({ id: mediaAssets.id });
  await db.insert(mediaDerivatives).values({ assetId: asset!.id, kind: "web_md", storageKey: `media/${fishAssetId}/md`, contentType: "image/jpeg", width: 800, height: 600, byteSize: 500 });
  await db.insert(shopProductImages).values({ productId: fish.id, assetId: asset!.id, position: 0 });
});

afterAll(async () => {
  await close();
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_shop");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("what a page may say", () => {
  it("reads a checkout request and refuses the rest", () => {
    expect(parseCheckoutRequest({ productId: fish.publicId, quantity: 2, returnTo: "https://acme.example/shop/fish" })).toEqual({
      productId: fish.publicId,
      quantity: 2,
      returnTo: "https://acme.example/shop/fish",
    });
    expect(parseCheckoutRequest({ productId: fish.publicId })).toMatchObject({ quantity: 1, returnTo: null });
    expect(parseCheckoutRequest({ productId: "nope" })).toBeNull();
    expect(parseCheckoutRequest({ productId: fish.publicId, quantity: 0 })).toBeNull();
    expect(parseCheckoutRequest({ productId: fish.publicId, quantity: 11 })).toBeNull();
    expect(parseCheckoutRequest({ productId: fish.publicId, quantity: 1.5 })).toBeNull();
    expect(parseCheckoutRequest(null)).toBeNull();
  });

  it("sends the buyer back only to the site's own pages", () => {
    const origins = siteOrigins({ primaryDomain: "acme.example", productionUrl: "https://acme-site.netlify.app", netlifySiteName: "acme-site" });
    expect(origins).toEqual(["https://acme.example", "https://www.acme.example", "https://acme-site.netlify.app"]);
    expect(returnBase(origins, "https://acme.example/shop/fish?x=1")).toBe("https://acme.example/shop/fish");
    expect(returnBase(origins, "https://evil.example/shop")).toBe("https://acme.example/shop");
    expect(returnBase(origins, 42)).toBe("https://acme.example/shop");
    expect(returnBase([], "https://acme.example/shop")).toBeNull();
    expect(siteOrigins({ primaryDomain: null, productionUrl: "http://insecure.example", netlifySiteName: null })).toEqual([]);
    expect(checkoutReturnUrls("https://acme.example/shop", "ORDER1")).toEqual({
      success: "https://acme.example/shop?shop=paid&order=ORDER1",
      cancel: "https://acme.example/shop?shop=cancelled",
    });
  });
});

describe("the feed", () => {
  it("lists what the client put on the site, and nothing else", async () => {
    const shop = (await listShopForSite(db, sitePublicId, imageUrl))!;
    expect(shop).toMatchObject({ open: true, fulfilment: "ship", shippingCents: 850, currency: "usd" });
    expect(shop.products.map((p) => p.id).sort()).toEqual([fish.publicId, trout.publicId].sort());
    const fishView = shop.products.find((p) => p.id === fish.publicId)!;
    expect(fishView).toMatchObject({ priceCents: 15000, available: 1, images: [imageUrl(fish.publicId, 0)] });
    expect(shop.products.find((p) => p.id === trout.publicId)).toMatchObject({ available: null, images: [] });
  });

  it("answers closed and empty for a site with no shop, and nothing for an unknown one", async () => {
    const [bare] = await db.insert(sites).values({ publicId: newPublicId(), organizationId: globex.organizationId, name: "Globex" }).returning({ publicId: sites.publicId });
    expect(await listShopForSite(db, bare!.publicId, imageUrl)).toMatchObject({ open: false, products: [] });
    expect(await listShopForSite(db, newPublicId(), imageUrl)).toBeNull();
  });

  it("serves a photo only while its product is on the site and the photo is in the library", async () => {
    expect(await findProductImage(db, sitePublicId, fish.publicId, 0)).toMatchObject({ contentType: "image/jpeg", byteSize: 500 });
    expect(await findProductImage(db, sitePublicId, fish.publicId, 1)).toBeNull();
    expect(await findProductImage(db, sitePublicId, fish.publicId, 0, "web_lg")).toBeNull();
    expect(await findProductImage(db, sitePublicId, hidden.publicId, 0)).toBeNull();
    expect(await findProductImage(db, newPublicId(), fish.publicId, 0)).toBeNull();

    await db.update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.publicId, fishAssetId));
    expect(await findProductImage(db, sitePublicId, fish.publicId, 0)).toBeNull();
    expect((await listShopForSite(db, sitePublicId, imageUrl))!.products.find((p) => p.id === fish.publicId)!.images).toEqual([]);
    await db.update(mediaAssets).set({ deletedAt: null }).where(eq(mediaAssets.publicId, fishAssetId));
  });
});

describe("starting a checkout", () => {
  let fishOrder: string;

  it("refuses what cannot be bought", async () => {
    expect(await beginShopCheckout(db, { sitePublicId: newPublicId(), request: { productId: fish.publicId, quantity: 1, returnTo: null }, portalBase: null })).toMatchObject({ reason: "unknown_site" });
    expect(await beginShopCheckout(db, { sitePublicId, request: { productId: hidden.publicId, quantity: 1, returnTo: null }, portalBase: null })).toMatchObject({ reason: "unknown_product" });
    expect(await beginShopCheckout(db, { sitePublicId, request: { productId: fish.publicId, quantity: 2, returnTo: null }, portalBase: null })).toMatchObject({ reason: "sold_out" });
    expect(stripeState.created).toHaveLength(0);
    expect((await productRow(fish.id)).reserved).toBe(0);
  });

  it("refuses while the shop cannot take money", async () => {
    await db.update(shopSettings).set({ chargesEnabled: false }).where(eq(shopSettings.siteId, siteId));
    expect(await beginShopCheckout(db, { sitePublicId, request: { productId: fish.publicId, quantity: 1, returnTo: null }, portalBase: null })).toMatchObject({ reason: "not_open" });
    await db.update(shopSettings).set({ chargesEnabled: true }).where(eq(shopSettings.siteId, siteId));
    expect((await productRow(fish.id)).reserved).toBe(0);
  });

  it("holds the unit, writes the order, and sends the buyer to Stripe on the client's own account", async () => {
    const started = await beginShopCheckout(db, {
      sitePublicId,
      request: { productId: fish.publicId, quantity: 1, returnTo: "https://acme.example/shop/small-cast-fish" },
      portalBase: "https://portal.example.test",
    });
    expect(started).toMatchObject({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    if (!started.ok) return;
    fishOrder = started.orderPublicId;

    expect((await productRow(fish.id))).toEqual({ stock: 1, reserved: 1 });
    expect(await eventsFor(fish.id)).toEqual(["stock_reserved"]);

    const order = await orderRow(fishOrder);
    expect(order).toMatchObject({ status: "pending", stripeSessionId: "cs_test_1", stripeAccountId: "acct_acme", subtotalCents: 15000, shippingCents: 850, totalCents: 15850, fulfilment: "ship" });

    const { params, options } = stripeState.created[0]!;
    expect(options).toEqual({ stripeAccount: "acct_acme", idempotencyKey: `shop-checkout:${fishOrder}` });
    expect(params.line_items?.[0]).toMatchObject({ quantity: 1, price_data: { currency: "usd", unit_amount: 15000, product_data: { name: "Small cast fish" } } });
    expect(params.line_items?.[0]?.price_data?.product_data?.images?.[0]).toContain(`/shop/products/${fish.publicId}/images/0`);
    expect(params.shipping_address_collection).toEqual({ allowed_countries: ["US"] });
    expect(params.shipping_options?.[0]?.shipping_rate_data).toMatchObject({ fixed_amount: { amount: 850, currency: "usd" } });
    expect(params.success_url).toBe(`https://acme.example/shop/small-cast-fish?shop=paid&order=${fishOrder}`);
    expect(params.cancel_url).toBe("https://acme.example/shop/small-cast-fish?shop=cancelled");
    expect(params.metadata).toMatchObject({ site_public_id: sitePublicId, order_public_id: fishOrder, product_public_id: fish.publicId });
    const inThirty = Math.floor(Date.now() / 1000) + 30 * 60;
    expect(Math.abs((params.expires_at ?? 0) - inThirty)).toBeLessThan(5);
  });

  it("will not hold the same last unit twice", async () => {
    expect(await beginShopCheckout(db, { sitePublicId, request: { productId: fish.publicId, quantity: 1, returnTo: null }, portalBase: null })).toMatchObject({ reason: "sold_out" });
    expect((await productRow(fish.id))).toEqual({ stock: 1, reserved: 1 });
  });

  it("ignores a return address that is not the site's, and counts nothing against unlimited stock", async () => {
    const started = await beginShopCheckout(db, { sitePublicId, request: { productId: trout.publicId, quantity: 3, returnTo: "https://evil.example/pay" }, portalBase: null });
    expect(started).toMatchObject({ ok: true });
    const { params } = stripeState.created.at(-1)!;
    expect(params.success_url?.startsWith("https://acme.example/shop?shop=paid")).toBe(true);
    expect(params.line_items?.[0]?.price_data?.product_data?.images).toBeUndefined();
    expect((await productRow(trout.id))).toEqual({ stock: null, reserved: 3 });
  });

  it("gives the unit straight back when Stripe cannot make a session", async () => {
    stripeState.failNext = true;
    const before = (await productRow(trout.id)).reserved;
    const started = await beginShopCheckout(db, { sitePublicId, request: { productId: trout.publicId, quantity: 1, returnTo: null }, portalBase: null });
    expect(started).toMatchObject({ ok: false, reason: "stripe_failed" });
    expect((await productRow(trout.id)).reserved).toBe(before);
    expect(await eventsFor(trout.id)).toContain("stock_released");
  });

  describe("what Stripe reports", () => {
    const sent: EmailMessage[] = [];
    const send = async (message: EmailMessage) => {
      sent.push(message);
      return { status: "sent" as const, id: "em_1" };
    };

    it("turns a paid session into a sale, once, and tells the client", async () => {
      const session = paidSession("cs_test_1");
      const outcome = await settleCheckoutSession(db, session, { send, portalBase: "https://portal.example.test" });
      expect(outcome.status).toBe("processed");

      const order = await orderRow(fishOrder);
      expect(order).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_cs_test_1", buyerName: "Dana Reyes", buyerEmail: "dana@example.test", totalCents: 15850, shippingCents: 850 });
      expect(order.paidAt).not.toBeNull();
      expect(order.shippingAddress).toMatchObject({ city: "Riverton", postalCode: "84065", country: "US" });
      expect((await productRow(fish.id))).toEqual({ stock: 0, reserved: 0 });
      expect(await eventsFor(fish.id)).toEqual(["stock_reserved", "stock_sold"]);

      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toContain("@example.test");
      expect(sent[0]!.subject).toContain("$158.50");
      expect(sent[0]!.text).toContain("Riverton");
      expect(sent[0]!.text).toContain("https://portal.example.test/dashboard/growth/shop/orders");

      expect((await settleCheckoutSession(db, session, { send })).status).toBe("ignored");
      expect((await productRow(fish.id))).toEqual({ stock: 0, reserved: 0 });
      expect(sent).toHaveLength(1);
    });

    it("does not count a session that is not paid, or one it has no order for", async () => {
      expect((await settleCheckoutSession(db, paidSession("cs_test_2", { payment_status: "unpaid" }), { send })).status).toBe("ignored");
      expect((await orderRow((await db.select({ p: shopOrders.publicId }).from(shopOrders).where(eq(shopOrders.stripeSessionId, "cs_test_2")))[0]!.p)).status).toBe("pending");
      expect((await settleCheckoutSession(db, paidSession("cs_test_999"), { send })).status).toBe("unmatched");
    });

    it("gives an abandoned session's units back, once", async () => {
      expect((await expireCheckoutSession(db, "cs_test_2")).status).toBe("processed");
      expect((await productRow(trout.id)).reserved).toBe(0);
      expect((await expireCheckoutSession(db, "cs_test_2")).status).toBe("ignored");
      expect((await expireCheckoutSession(db, "cs_test_999")).status).toBe("unmatched");
    });

    it("marks a refund and leaves the shelf alone", async () => {
      const charge = { id: "ch_1", object: "charge", payment_intent: "pi_cs_test_1", amount: 15850, amount_refunded: 15850, refunded: true } as Stripe.Charge;
      expect((await recordShopRefund(db, charge)).status).toBe("processed");
      expect((await orderRow(fishOrder))).toMatchObject({ status: "refunded" });
      expect((await productRow(fish.id))).toEqual({ stock: 0, reserved: 0 });
      expect((await recordShopRefund(db, charge)).status).toBe("unmatched");
      expect((await recordShopRefund(db, { id: "ch_2", payment_intent: null } as Stripe.Charge)).status).toBe("unmatched");
    });
  });

  describe("the sweep", () => {
    it("asks Stripe before giving up on a stale checkout", async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60 * 60 * 1000);
      // One Stripe knows was paid, one Stripe says expired, one that never got a session, and one still open.
      const paidButLost = await beginShopCheckout(db, { sitePublicId, request: { productId: trout.publicId, quantity: 1, returnTo: null }, portalBase: null });
      const abandoned = await beginShopCheckout(db, { sitePublicId, request: { productId: trout.publicId, quantity: 1, returnTo: null }, portalBase: null });
      const stillOpen = await beginShopCheckout(db, { sitePublicId, request: { productId: trout.publicId, quantity: 1, returnTo: null }, portalBase: null });
      if (!paidButLost.ok || !abandoned.ok || !stillOpen.ok) throw new Error("setup");
      const crashed = newPublicId();
      await db.insert(shopOrders).values({
        publicId: crashed,
        organizationId: acme.organizationId,
        siteId,
        stripeAccountId: "acct_acme",
        stripeSessionId: `pending:${crashed}`,
        fulfilment: "ship",
        subtotalCents: 4000,
        totalCents: 4850,
        expiresAt: past,
      });
      for (const id of [paidButLost.orderPublicId, abandoned.orderPublicId]) {
        await db.update(shopOrders).set({ expiresAt: past }).where(eq(shopOrders.publicId, id));
      }
      await db.update(shopOrders).set({ expiresAt: new Date(now.getTime() - 60 * 1000) }).where(eq(shopOrders.publicId, stillOpen.orderPublicId));

      const lostSession = (await orderRow(paidButLost.orderPublicId)).stripeSessionId;
      stripeState.sessions.set(lostSession, paidSession(lostSession, { customer_details: { name: "Sam", email: "sam@example.test" } as never }));
      const abandonedSession = (await orderRow(abandoned.orderPublicId)).stripeSessionId;
      stripeState.sessions.set(abandonedSession, { ...stripeState.sessions.get(abandonedSession)!, status: "expired" });

      const reservedBefore = (await productRow(trout.id)).reserved;
      const result = await reconcileStaleCheckouts(db, { now });
      expect(result).toEqual({ checked: 4, settled: 1, expired: 2, left: 1 });
      expect((await orderRow(paidButLost.orderPublicId)).status).toBe("paid");
      expect((await orderRow(abandoned.orderPublicId)).status).toBe("expired");
      expect((await orderRow(crashed)).status).toBe("expired");
      expect((await orderRow(stillOpen.orderPublicId)).status).toBe("pending");
      // The paid one sold its unit, the abandoned one released it, the open one still holds it.
      expect((await productRow(trout.id)).reserved).toBe(reservedBefore - 2);
    });
  });

  describe("from the client's side", () => {
    it("lists paid orders with what was bought, and only the client's own", async () => {
      const orders = await listOrders(db, acme.ctx);
      expect(orders.map((o) => o.status).sort()).toEqual(["paid", "refunded"]);
      const refunded = orders.find((o) => o.status === "refunded")!;
      expect(refunded).toMatchObject({ publicId: fishOrder, buyerName: "Dana Reyes", totalCents: 15850, restocked: false });
      expect(refunded.items).toEqual([{ name: "Small cast fish", unitCents: 15000, quantity: 1, productPublicId: fish.publicId }]);
      expect(await countOrdersAwaitingShipment(db, acme.ctx)).toBe(1);
      expect(await listOrders(db, globex.ctx)).toEqual([]);
      await expect(markOrderShipped(db, globex.ctx, fishOrder)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("marks an order shipped and emails the buyer in the business's name", async () => {
      vi.stubEnv("RESEND_FROM_ADDRESS", "MortensenWeb <hello@offers.mortensenweb.com>");
      const sent: EmailMessage[] = [];
      const send = async (message: EmailMessage) => {
        sent.push(message);
        return { status: "sent" as const, id: "em_2" };
      };
      const paid = (await listOrders(db, acme.ctx)).find((o) => o.status === "paid")!;
      const result = await markOrderShipped(db, acme.ctx, paid.publicId, { send });
      expect(result).toMatchObject({ ok: true });
      expect(result.message).toContain("emailed");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("sam@example.test");
      expect(sent[0]!.from).toBe('"Acme" <hello@offers.mortensenweb.com>');
      expect(sent[0]!.text).toContain("Orders go out within 3 working days.");
      expect((await orderRow(paid.publicId)).status).toBe("shipped");

      expect(await markOrderShipped(db, acme.ctx, paid.publicId, { send })).toMatchObject({ ok: false });
      expect(await markOrderShipped(db, acme.ctx, fishOrder, { send })).toMatchObject({ ok: false });
      expect(sent).toHaveLength(1);
    });

    it("restocks a refunded order once, by the client's own hand", async () => {
      expect((await productRow(fish.id)).stock).toBe(0);
      expect(await restockOrder(db, acme.ctx, fishOrder)).toMatchObject({ ok: true, message: "Restocked 1 unit." });
      expect((await productRow(fish.id)).stock).toBe(1);
      expect(await restockOrder(db, acme.ctx, fishOrder)).toMatchObject({ ok: false, message: "Already restocked." });
      expect((await productRow(fish.id)).stock).toBe(1);
      expect((await listOrders(db, acme.ctx)).find((o) => o.publicId === fishOrder)!.restocked).toBe(true);

      const shipped = (await listOrders(db, acme.ctx)).find((o) => o.status === "shipped")!;
      expect(await restockOrder(db, acme.ctx, shipped.publicId)).toMatchObject({ ok: false });
    });

    it("is read-only while an operator is viewing as the client", async () => {
      const viewing = tenantContextFrom(
        { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
        acme.organizationId,
        { impersonating: true },
      );
      await expect(markOrderShipped(db, viewing, fishOrder)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(restockOrder(db, viewing, fishOrder)).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
