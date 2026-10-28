import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { mediaAssets, mediaUsages, shopProductEvents, shopProducts, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { slugify, stockLabel, uniqueSlug, validateProductInput } from "@/lib/shop/products";
import { money } from "@/lib/shop/money";
import {
  countProducts,
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  setProductStatus,
  updateProduct,
} from "@/db/repositories/client/shop-products";
import { AuthorizationError, NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Products, from the client's side.
 *
 * What would go wrong quietly: a photo from another client's library on a
 * product; a price Stripe cannot charge; stock set below what customers are
 * holding in checkout; a rename changing a product's address on the site;
 * a deleted product still listed, or still "using" its photos; and a change
 * nobody can account for afterwards.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

async function addSite(tenant: SeededTenant) {
  await db.insert(sites).values({
    publicId: newPublicId(),
    organizationId: tenant.organizationId,
    name: `site-${newPublicId().slice(0, 6).toLowerCase()}`,
    status: "live",
  });
}

async function addAsset(tenant: SeededTenant, status: "ready" | "processing" = "ready"): Promise<string> {
  const publicId = newPublicId();
  await db.insert(mediaAssets).values({
    publicId,
    organizationId: tenant.organizationId,
    status,
    storageKey: `media/${publicId}`,
    originalFilename: `${publicId.slice(0, 6).toLowerCase()}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1000,
    checksumSha256: "0".repeat(64),
  });
  return publicId;
}

const fish = { name: "Small cast fish", description: "Bronze, 2024.", price: "150", stock: "3", photoPublicIds: [] as string[] };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
  await addSite(acme);
  await addSite(globex);
});

afterAll(async () => {
  await close();
});

describe("what a client types", () => {
  it("reads a product and refuses what cannot be sold", () => {
    const ok = validateProductInput({ name: "  Small   cast fish ", description: "", price: "$1,250.50", stock: "" });
    expect(ok).toMatchObject({ ok: true, fields: { name: "Small cast fish", description: null, priceCents: 125050, stock: null } });

    expect(validateProductInput({ name: " ", description: "", price: "10", stock: "" })).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "Fish", description: "", price: "0.49", stock: "" })).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "Fish", description: "", price: "ten", stock: "" })).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "Fish", description: "", price: "15000000", stock: "" })).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "Fish", description: "", price: "10", stock: "-1" })).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "Fish", description: "", price: "10", stock: "2.5" })).toMatchObject({ ok: false });
    expect(validateProductInput({ name: "Fish", description: "x".repeat(2001), price: "10", stock: "" })).toMatchObject({ ok: false });
  });

  it("makes a site address from a name, and a unique one from a taken one", () => {
    expect(slugify("Small Cast Fish (2024)")).toBe("small-cast-fish-2024");
    expect(slugify("Café au lait — large")).toBe("cafe-au-lait-large");
    expect(slugify("***")).toBe("product");
    expect(uniqueSlug("trout", new Set(["trout", "trout-2"]))).toBe("trout-3");
  });

  it("says what is left in words a seller uses", () => {
    expect(stockLabel(null, 0)).toBe("Unlimited");
    expect(stockLabel(3, 0)).toBe("3 units left");
    expect(stockLabel(1, 0)).toBe("1 unit left");
    expect(stockLabel(0, 0)).toBe("Sold out");
    expect(stockLabel(3, 2)).toBe("1 unit left, 2 held in open checkouts");
    expect(money(125050)).toBe("$1,250.50");
  });
});

describe("adding and changing products", () => {
  let fishId: string;
  let photoA: string;
  let photoB: string;

  it("adds a product with photos from the client's own library, hidden until it is put on the site", async () => {
    photoA = await addAsset(acme);
    photoB = await addAsset(acme);
    const result = await createProduct(db, acme.ctx, { ...fish, photoPublicIds: [photoB, photoA] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    fishId = result.publicId;

    const product = await getProduct(db, acme.ctx, fishId);
    expect(product).toMatchObject({ name: "Small cast fish", slug: "small-cast-fish", priceCents: 15000, stock: 3, reserved: 0, status: "hidden" });
    expect(product.photos.map((p) => p.assetPublicId)).toEqual([photoB, photoA]);
    expect(product.coverAssetPublicId).toBe(photoB);
    expect(product.history.map((h) => h.action)).toEqual(["created"]);

    const usages = await db
      .select({ location: mediaUsages.location, state: mediaUsages.state })
      .from(mediaUsages)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaUsages.assetId))
      .where(eq(mediaAssets.publicId, photoA));
    expect(usages).toEqual([{ location: "Shop: Small cast fish", state: "pending" }]);
  });

  it("refuses a photo from another client's library, and one still being prepared", async () => {
    const theirs = await addAsset(globex);
    expect(await createProduct(db, acme.ctx, { ...fish, photoPublicIds: [theirs] })).toMatchObject({ ok: false });
    const notReady = await addAsset(acme, "processing");
    expect(await createProduct(db, acme.ctx, { ...fish, photoPublicIds: [notReady] })).toMatchObject({ ok: false });
    expect(await createProduct(db, acme.ctx, { ...fish, photoPublicIds: Array.from({ length: 7 }, () => photoA) })).toMatchObject({
      ok: true,
    }); // duplicates collapse to one photo
    expect(
      await createProduct(db, acme.ctx, { ...fish, photoPublicIds: await Promise.all(Array.from({ length: 7 }, () => addAsset(acme))) }),
    ).toMatchObject({ ok: false });
  });

  it("gives a second product of the same name its own address", async () => {
    const again = await createProduct(db, acme.ctx, fish);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect((await getProduct(db, acme.ctx, again.publicId)).slug).toBe("small-cast-fish-3");
  });

  it("records what changed, keeps the address, and keeps the photo list in step", async () => {
    const result = await updateProduct(db, acme.ctx, fishId, {
      name: "Small cast trout",
      description: "Bronze, 2024.",
      price: "160",
      stock: "",
      photoPublicIds: [photoA],
    });
    expect(result).toMatchObject({ ok: true });

    const product = await getProduct(db, acme.ctx, fishId);
    expect(product.name).toBe("Small cast trout");
    expect(product.slug).toBe("small-cast-fish");
    expect(product.priceCents).toBe(16000);
    expect(product.stock).toBeNull();
    expect(product.photos.map((p) => p.assetPublicId)).toEqual([photoA]);

    const [latest] = product.history;
    expect(latest!.action).toBe("updated");
    expect(latest!.changes).toEqual({
      name: { from: "Small cast fish", to: "Small cast trout" },
      priceCents: { from: 15000, to: 16000 },
      stock: { from: 3, to: null },
      photos: { from: 2, to: 1 },
    });

    const states = await db
      .select({ asset: mediaAssets.publicId, state: mediaUsages.state, location: mediaUsages.location })
      .from(mediaUsages)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaUsages.assetId))
      .where(eq(mediaAssets.organizationId, acme.organizationId));
    expect(states.find((s) => s.asset === photoB)?.state).toBe("removed");
    expect(states.find((s) => s.asset === photoA)).toMatchObject({ state: "pending", location: "Shop: Small cast trout" });
  });

  it("says so when nothing changed", async () => {
    const result = await updateProduct(db, acme.ctx, fishId, {
      name: "Small cast trout",
      description: "Bronze, 2024.",
      price: "160.00",
      stock: "",
      photoPublicIds: [photoA],
    });
    expect(result).toMatchObject({ ok: true, message: "Nothing changed." });
    expect((await getProduct(db, acme.ctx, fishId)).history.filter((h) => h.action === "updated")).toHaveLength(1);
  });

  it("will not set stock below what customers are holding in checkout", async () => {
    await db.update(shopProducts).set({ stock: 5, reserved: 2 }).where(eq(shopProducts.publicId, fishId));
    const lower = await updateProduct(db, acme.ctx, fishId, { ...fish, name: "Small cast trout", stock: "1", photoPublicIds: [photoA] });
    expect(lower).toMatchObject({ ok: false });
    expect(lower.ok ? "" : lower.message).toMatch(/2 units are held/);
    const exact = await updateProduct(db, acme.ctx, fishId, { ...fish, name: "Small cast trout", stock: "2", photoPublicIds: [photoA] });
    expect(exact).toMatchObject({ ok: true });
    expect((await getProduct(db, acme.ctx, fishId)).stock).toBe(2);
  });

  it("puts a product on the site and takes it off, with the library told each time", async () => {
    expect(await setProductStatus(db, acme.ctx, fishId, "active")).toMatchObject({ ok: true });
    expect((await getProduct(db, acme.ctx, fishId)).status).toBe("active");
    let [usage] = await db
      .select({ state: mediaUsages.state })
      .from(mediaUsages)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaUsages.assetId))
      .where(and(eq(mediaAssets.publicId, photoA), eq(mediaUsages.location, "Shop: Small cast trout")));
    expect(usage!.state).toBe("published");

    expect(await setProductStatus(db, acme.ctx, fishId, "active")).toMatchObject({ ok: true, message: "Already on your website." });
    expect(await setProductStatus(db, acme.ctx, fishId, "hidden")).toMatchObject({ ok: true });
    [usage] = await db
      .select({ state: mediaUsages.state })
      .from(mediaUsages)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaUsages.assetId))
      .where(and(eq(mediaAssets.publicId, photoA), eq(mediaUsages.location, "Shop: Small cast trout")));
    expect(usage!.state).toBe("pending");

    const actions = (await getProduct(db, acme.ctx, fishId)).history.map((h) => h.action);
    expect(actions.slice(0, 2)).toEqual(["hidden", "activated"]);
  });

  it("lists the client's products with cover and count, and counts what is on the site", async () => {
    const list = await listProducts(db, acme.ctx);
    expect(list.length).toBeGreaterThanOrEqual(3);
    const trout = list.find((p) => p.publicId === fishId)!;
    expect(trout).toMatchObject({ coverAssetPublicId: photoA, photoCount: 1, status: "hidden" });
    expect(await countProducts(db, acme.ctx)).toEqual({ total: list.length, onSite: 0 });
  });

  it("is nobody else's product", async () => {
    await expect(getProduct(db, globex.ctx, fishId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProduct(db, globex.ctx, fishId, fish)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setProductStatus(db, globex.ctx, fishId, "active")).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteProduct(db, globex.ctx, fishId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listProducts(db, globex.ctx)).toEqual([]);
  });

  it("is read-only while an operator is viewing as the client", async () => {
    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(createProduct(db, viewing, fish)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(setProductStatus(db, viewing, fishId, "active")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(deleteProduct(db, viewing, fishId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("will not delete a product a customer is paying for, and deletes softly otherwise", async () => {
    expect(await deleteProduct(db, acme.ctx, fishId)).toMatchObject({ ok: false });

    await db.update(shopProducts).set({ reserved: 0 }).where(eq(shopProducts.publicId, fishId));
    expect(await deleteProduct(db, acme.ctx, fishId)).toMatchObject({ ok: true });

    expect((await listProducts(db, acme.ctx)).some((p) => p.publicId === fishId)).toBe(false);
    const gone = await getProduct(db, acme.ctx, fishId);
    expect(gone.deleted).toBe(true);
    expect(gone.status).toBe("hidden");
    expect(await updateProduct(db, acme.ctx, fishId, fish)).toMatchObject({ ok: false });
    expect(await setProductStatus(db, acme.ctx, fishId, "active")).toMatchObject({ ok: false });

    const events = await db
      .select({ action: shopProductEvents.action })
      .from(shopProductEvents)
      .innerJoin(shopProducts, eq(shopProducts.id, shopProductEvents.productId))
      .where(eq(shopProducts.publicId, fishId));
    expect(events.map((e) => e.action)).toContain("deleted");

    // Its address is free again.
    const reuse = await createProduct(db, acme.ctx, { ...fish, name: "Small cast fish" });
    expect(reuse.ok).toBe(true);
    if (reuse.ok) expect((await getProduct(db, acme.ctx, reuse.publicId)).slug).toBe("small-cast-fish");
  });

  it("has no products for a client with no website", async () => {
    const tenant = await seedTenant(db, "Initech");
    expect(await listProducts(db, tenant.ctx)).toEqual([]);
    expect(await createProduct(db, tenant.ctx, fish)).toMatchObject({ ok: false });
  });
});
