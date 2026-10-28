import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  mediaAssets,
  mediaUsages,
  shopProductEvents,
  shopProductImages,
  shopProducts,
  type ShopProductAction,
  type ShopProductStatus,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  MAX_PRODUCT_PHOTOS,
  slugify,
  uniqueSlug,
  validateProductInput,
  type ProductFields,
} from "@/lib/shop/products";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { validateAssetSelection } from "./request-assets";
import { shopSiteFor } from "./shop-settings";

/**
 * A client's products, tenant-scoped.
 *
 * Every lookup filters on `ctx.organizationId`; a public id from another
 * tenant is `NotFoundError`, indistinguishable from one that never existed.
 * Photos are the client's own library images, resolved the same way a
 * request's attachments are, so an id from another tenant's library resolves
 * to nothing.
 *
 * ## Stock is two numbers
 *
 * `stock` is units on hand; `reserved` is units held by open checkouts. The
 * site sells `stock - reserved`, and the database refuses `reserved > stock`.
 * This file never touches `reserved` — only the checkout path and the
 * webhook do — but it refuses to set `stock` below it, because that would
 * mean telling a customer mid-checkout that the thing they are paying for
 * is gone.
 *
 * ## Deletion is soft
 *
 * A deleted product keeps its row: orders point at it, and the audit log
 * does. It leaves the site and the list, and its slug is free for another.
 */

export interface ProductSummary {
  publicId: string;
  name: string;
  slug: string;
  priceCents: number;
  stock: number | null;
  reserved: number;
  status: ShopProductStatus;
  coverAssetPublicId: string | null;
  photoCount: number;
  updatedAt: Date;
}

export interface ProductPhoto {
  assetPublicId: string;
  title: string;
  /** False when trashed or not ready: shown on the form, not on the site. */
  usable: boolean;
}

export interface ProductEvent {
  action: ShopProductAction;
  changes: Record<string, unknown>;
  createdAt: Date;
}

export interface ProductDetail extends ProductSummary {
  description: string | null;
  photos: ProductPhoto[];
  history: ProductEvent[];
  deleted: boolean;
}

export type ProductResult = { ok: true; message: string; publicId: string } | { ok: false; message: string };

export interface ProductInput {
  name: string;
  description: string;
  /** Dollars as typed. */
  price: string;
  /** Units as typed; blank for unlimited. */
  stock: string;
  photoPublicIds: string[];
}

const HISTORY_LIMIT = 20;

function usageLocation(name: string): string {
  return `Shop: ${name}`;
}

type ProductRow = typeof shopProducts.$inferSelect;

async function ownProduct(db: Database, ctx: TenantContext, publicId: string): Promise<ProductRow> {
  const [row] = await db
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.publicId, publicId), eq(shopProducts.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

async function record(
  db: Database,
  ctx: TenantContext,
  productId: string,
  action: ShopProductAction,
  changes: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(shopProductEvents).values({
    productId,
    organizationId: ctx.organizationId,
    actorId: ctx.userId,
    action,
    changes,
  });
}

async function photosOf(db: Database, productIds: string[]) {
  if (productIds.length === 0) return [];
  return db
    .select({
      productId: shopProductImages.productId,
      position: shopProductImages.position,
      assetPublicId: mediaAssets.publicId,
      title: mediaAssets.title,
      filename: mediaAssets.originalFilename,
      status: mediaAssets.status,
      trashed: mediaAssets.deletedAt,
    })
    .from(shopProductImages)
    .innerJoin(mediaAssets, eq(mediaAssets.id, shopProductImages.assetId))
    .where(inArray(shopProductImages.productId, productIds))
    .orderBy(asc(shopProductImages.productId), asc(shopProductImages.position));
}

type PhotoRow = Awaited<ReturnType<typeof photosOf>>[number];

function toPhoto(row: PhotoRow): ProductPhoto {
  return {
    assetPublicId: row.assetPublicId,
    title: row.title ?? row.filename,
    usable: row.status === "ready" && row.trashed === null,
  };
}

function toSummary(row: ProductRow, photos: PhotoRow[]): ProductSummary {
  const usable = photos.filter((p) => toPhoto(p).usable);
  return {
    publicId: row.publicId,
    name: row.name,
    slug: row.slug,
    priceCents: row.priceCents,
    stock: row.stock,
    reserved: row.reserved,
    status: row.status as ShopProductStatus,
    coverAssetPublicId: usable[0]?.assetPublicId ?? null,
    photoCount: photos.length,
    updatedAt: row.updatedAt,
  };
}

/** The shop's products, the order they appear on the site. Deleted ones are gone. */
export async function listProducts(db: Database, ctx: TenantContext): Promise<ProductSummary[]> {
  const site = await shopSiteFor(db, ctx);
  if (!site) return [];
  const rows = await db
    .select()
    .from(shopProducts)
    .where(
      and(eq(shopProducts.organizationId, ctx.organizationId), eq(shopProducts.siteId, site.id), isNull(shopProducts.deletedAt)),
    )
    .orderBy(asc(shopProducts.sortOrder), desc(shopProducts.createdAt));
  const photos = await photosOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toSummary(row, photos.filter((p) => p.productId === row.id)));
}

export async function getProduct(db: Database, ctx: TenantContext, publicId: string): Promise<ProductDetail> {
  const row = await ownProduct(db, ctx, publicId);
  const photos = await photosOf(db, [row.id]);
  const events = await db
    .select({ action: shopProductEvents.action, changes: shopProductEvents.changes, createdAt: shopProductEvents.createdAt })
    .from(shopProductEvents)
    .where(eq(shopProductEvents.productId, row.id))
    .orderBy(desc(shopProductEvents.createdAt))
    .limit(HISTORY_LIMIT);
  return {
    ...toSummary(row, photos),
    description: row.description,
    photos: photos.map(toPhoto),
    history: events.map((e) => ({
      action: e.action as ShopProductAction,
      changes: (e.changes ?? {}) as Record<string, unknown>,
      createdAt: e.createdAt,
    })),
    deleted: row.deletedAt !== null,
  };
}

type Checked = { ok: true; fields: ProductFields; assets: Array<{ id: string; publicId: string }> } | { ok: false; message: string };

async function check(db: Database, ctx: TenantContext, input: ProductInput): Promise<Checked> {
  const fields = validateProductInput(input);
  if (!fields.ok) return fields;
  const ids = [...new Set(input.photoPublicIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_PRODUCT_PHOTOS) return { ok: false, message: `Choose up to ${MAX_PRODUCT_PHOTOS} photos.` };
  const selection = await validateAssetSelection(db, ctx, ids);
  if (!selection.ok) return { ok: false, message: selection.message };
  return { ok: true, fields: fields.fields, assets: selection.assets };
}

async function freeSlugFor(db: Database, siteId: string, name: string): Promise<string> {
  const base = slugify(name);
  const taken = await db
    .select({ slug: shopProducts.slug })
    .from(shopProducts)
    .where(and(eq(shopProducts.siteId, siteId), isNull(shopProducts.deletedAt), like(shopProducts.slug, `${base}%`)));
  return uniqueSlug(base, new Set(taken.map((t) => t.slug)));
}

/**
 * Replace a product's photos with `assets`, in that order, and keep the
 * library's "where is this used" in step. Deleting and re-inserting is the
 * simplest way to get the order right; the rows carry nothing else.
 *
 * Usage rows are found by their location text, "Shop: <name>", since the
 * table's own key is (asset, request). A rename therefore passes the
 * previous name too, so the rows it wrote under the old one are moved
 * rather than left behind as a phantom use.
 */
async function setPhotos(
  db: Database,
  product: { id: string; siteId: string; status: string },
  names: { previous: string; current: string },
  assets: Array<{ id: string }>,
): Promise<void> {
  const before = await db
    .select({ assetId: shopProductImages.assetId })
    .from(shopProductImages)
    .where(eq(shopProductImages.productId, product.id));
  const removed = before.map((b) => b.assetId).filter((id) => !assets.some((a) => a.id === id));

  await db.delete(shopProductImages).where(eq(shopProductImages.productId, product.id));
  if (assets.length > 0) {
    await db.insert(shopProductImages).values(assets.map((asset, position) => ({ productId: product.id, assetId: asset.id, position })));
  }

  const previous = usageLocation(names.previous);
  const location = usageLocation(names.current);
  const now = new Date();
  if (removed.length > 0) {
    await db
      .update(mediaUsages)
      .set({ state: "removed", location, lastSeenAt: now })
      .where(and(inArray(mediaUsages.assetId, removed), eq(mediaUsages.siteId, product.siteId), eq(mediaUsages.location, previous)));
  }
  const state = product.status === "active" ? "published" : "pending";
  for (const asset of assets) {
    // An existing row is refreshed rather than doubled: a photo re-saved ten
    // times shows once in the library, a photo on two products shows twice.
    const updated = await db
      .update(mediaUsages)
      .set({ state, location, lastSeenAt: now })
      .where(and(eq(mediaUsages.assetId, asset.id), eq(mediaUsages.siteId, product.siteId), eq(mediaUsages.location, previous)))
      .returning({ id: mediaUsages.id });
    if (updated.length === 0) {
      await db.insert(mediaUsages).values({ assetId: asset.id, siteId: product.siteId, location, state });
    }
  }
}

export async function createProduct(db: Database, ctx: TenantContext, input: ProductInput): Promise<ProductResult> {
  assertMutable(ctx);
  const site = await shopSiteFor(db, ctx);
  if (!site) return { ok: false, message: "Your shop goes on your website, and there is no website on your account yet." };
  const checked = await check(db, ctx, input);
  if (!checked.ok) return checked;

  const publicId = newPublicId();
  const [created] = await db
    .insert(shopProducts)
    .values({
      publicId,
      organizationId: ctx.organizationId,
      siteId: site.id,
      slug: await freeSlugFor(db, site.id, checked.fields.name),
      ...checked.fields,
      createdBy: ctx.userId,
    })
    .returning({ id: shopProducts.id, name: shopProducts.name, status: shopProducts.status, siteId: shopProducts.siteId });

  await setPhotos(db, created!, { previous: created!.name, current: created!.name }, checked.assets);
  await record(db, ctx, created!.id, "created", {
    name: checked.fields.name,
    priceCents: checked.fields.priceCents,
    stock: checked.fields.stock,
    photos: checked.assets.length,
  });
  return { ok: true, message: "Added. It is not on your website until you put it there.", publicId };
}

function diff(before: ProductRow, after: ProductFields): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of ["name", "description", "priceCents", "stock"] as const) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

export async function updateProduct(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: ProductInput,
): Promise<ProductResult> {
  assertMutable(ctx);
  const row = await ownProduct(db, ctx, publicId);
  if (row.deletedAt) return { ok: false, message: "That product was deleted." };
  const checked = await check(db, ctx, input);
  if (!checked.ok) return checked;

  if (checked.fields.stock !== null && checked.fields.stock < row.reserved) {
    const held = row.reserved === 1 ? "1 unit is" : `${row.reserved} units are`;
    return {
      ok: false,
      message: `${held} held by customers in checkout right now, so stock cannot go below that. Try again in half an hour.`,
    };
  }

  const changes = diff(row, checked.fields);
  const photosBefore = (await photosOf(db, [row.id])).map((p) => p.assetPublicId);
  const photosAfter = checked.assets.map((a) => a.publicId);
  const photosChanged = photosBefore.join(",") !== photosAfter.join(",");
  if (Object.keys(changes).length === 0 && !photosChanged) return { ok: true, message: "Nothing changed.", publicId };

  // The slug stays: it is the product's address on the site, and a rename
  // must not break a link somebody already shared.
  await db
    .update(shopProducts)
    .set({ ...checked.fields, updatedAt: new Date() })
    .where(eq(shopProducts.id, row.id));
  await setPhotos(db, row, { previous: row.name, current: checked.fields.name }, checked.assets);
  await record(db, ctx, row.id, "updated", {
    ...changes,
    ...(photosChanged ? { photos: { from: photosBefore.length, to: photosAfter.length } } : {}),
  });
  return { ok: true, message: "Saved.", publicId };
}

/** Put a product on the site, or take it off. The site reads `status` live. */
export async function setProductStatus(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  status: ShopProductStatus,
): Promise<ProductResult> {
  assertMutable(ctx);
  const row = await ownProduct(db, ctx, publicId);
  if (row.deletedAt) return { ok: false, message: "That product was deleted." };
  if (row.status === status) return { ok: true, message: status === "active" ? "Already on your website." : "Already off your website.", publicId };

  await db.update(shopProducts).set({ status, updatedAt: new Date() }).where(eq(shopProducts.id, row.id));
  await db
    .update(mediaUsages)
    .set({ state: status === "active" ? "published" : "pending", lastSeenAt: new Date() })
    .where(and(eq(mediaUsages.siteId, row.siteId), eq(mediaUsages.location, usageLocation(row.name))));
  await record(db, ctx, row.id, status === "active" ? "activated" : "hidden");
  return {
    ok: true,
    message: status === "active" ? "On your website. Customers can buy it now." : "Off your website. Nobody can buy it until you put it back.",
    publicId,
  };
}

/** Soft-delete. Refused while a checkout holds units: that customer is still paying for one. */
export async function deleteProduct(db: Database, ctx: TenantContext, publicId: string): Promise<ProductResult> {
  assertMutable(ctx);
  const row = await ownProduct(db, ctx, publicId);
  if (row.deletedAt) return { ok: true, message: "Already deleted.", publicId };
  if (row.reserved > 0) {
    return { ok: false, message: "A customer has this in checkout right now. Take it off your website instead, and delete it in half an hour." };
  }

  const now = new Date();
  await db.update(shopProducts).set({ deletedAt: now, status: "hidden", updatedAt: now }).where(eq(shopProducts.id, row.id));
  await db
    .update(mediaUsages)
    .set({ state: "removed", lastSeenAt: now })
    .where(and(eq(mediaUsages.siteId, row.siteId), eq(mediaUsages.location, usageLocation(row.name))));
  await record(db, ctx, row.id, "deleted", { name: row.name });
  return { ok: true, message: `${row.name} is deleted.`, publicId };
}

/** For the setup checklist: whether anything is on the site yet. */
export async function countProducts(db: Database, ctx: TenantContext): Promise<{ total: number; onSite: number }> {
  const site = await shopSiteFor(db, ctx);
  if (!site) return { total: 0, onSite: 0 };
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      onSite: sql<number>`count(*) filter (where ${shopProducts.status} = 'active')::int`,
    })
    .from(shopProducts)
    .where(and(eq(shopProducts.siteId, site.id), eq(shopProducts.organizationId, ctx.organizationId), isNull(shopProducts.deletedAt)));
  return { total: row?.total ?? 0, onSite: row?.onSite ?? 0 };
}
