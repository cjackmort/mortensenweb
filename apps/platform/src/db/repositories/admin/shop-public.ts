import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { mediaAssets, mediaDerivatives, shopProductImages, shopProducts, shopSettings, sites } from "@/db/schema";
import type { PublicShop } from "@/lib/shop/public";

/**
 * The shop as a visitor's browser reads it, with no session.
 *
 * Everything here is something the client chose to publish: a product they
 * put on the site, a photo they attached to it. Keyed by the site's public
 * id, and answering null for a site that does not exist, is archived, or has
 * no shop, so the route can say "unknown site" and nothing more.
 */

/** The derivative a product page shows; the feed's URLs point at this size. */
export const PRODUCT_IMAGE_KIND = "web_md" as const;
const IMAGE_KINDS = { sm: "web_sm", md: "web_md", lg: "web_lg" } as const;
export type ProductImageSize = keyof typeof IMAGE_KINDS;

export function imageKindFor(size: string | null): (typeof IMAGE_KINDS)[ProductImageSize] | null {
  if (size === null) return PRODUCT_IMAGE_KIND;
  return (IMAGE_KINDS as Record<string, (typeof IMAGE_KINDS)[ProductImageSize]>)[size] ?? null;
}

async function liveSite(db: Database, sitePublicId: string) {
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.publicId, sitePublicId), isNull(sites.archivedAt)))
    .limit(1);
  return site ?? null;
}

/** Image rows a visitor may see: on a product that is on the site, from a photo that is ready and not trashed. */
function visibleImage(sitePublicId: string, productPublicId?: string) {
  return and(
    eq(sites.publicId, sitePublicId),
    isNull(sites.archivedAt),
    eq(shopProducts.status, "active"),
    isNull(shopProducts.deletedAt),
    eq(mediaAssets.status, "ready"),
    isNull(mediaAssets.deletedAt),
    ...(productPublicId ? [eq(shopProducts.publicId, productPublicId)] : []),
  );
}

/**
 * The feed. Null for an unknown site. A site with no shop settings yet still
 * answers, closed and empty, so the island can tell "no shop" from "down".
 */
export async function listShopForSite(
  db: Database,
  sitePublicId: string,
  imageUrl: (productPublicId: string, index: number) => string,
): Promise<PublicShop | null> {
  const site = await liveSite(db, sitePublicId);
  if (!site) return null;

  const [settings] = await db.select().from(shopSettings).where(eq(shopSettings.siteId, site.id)).limit(1);

  const products = await db
    .select({
      id: shopProducts.id,
      publicId: shopProducts.publicId,
      name: shopProducts.name,
      slug: shopProducts.slug,
      description: shopProducts.description,
      priceCents: shopProducts.priceCents,
      stock: shopProducts.stock,
      reserved: shopProducts.reserved,
    })
    .from(shopProducts)
    .where(and(eq(shopProducts.siteId, site.id), eq(shopProducts.status, "active"), isNull(shopProducts.deletedAt)))
    .orderBy(asc(shopProducts.sortOrder), desc(shopProducts.createdAt));

  // One query for every visible image rather than one per product; the
  // index is the image's place among the product's visible ones, which is
  // what the image route counts too.
  const images =
    products.length === 0
      ? []
      : await db
          .select({ productPublicId: shopProducts.publicId, position: shopProductImages.position })
          .from(shopProductImages)
          .innerJoin(shopProducts, eq(shopProducts.id, shopProductImages.productId))
          .innerJoin(sites, eq(sites.id, shopProducts.siteId))
          .innerJoin(mediaAssets, eq(mediaAssets.id, shopProductImages.assetId))
          .innerJoin(mediaDerivatives, and(eq(mediaDerivatives.assetId, mediaAssets.id), eq(mediaDerivatives.kind, PRODUCT_IMAGE_KIND)))
          .where(visibleImage(sitePublicId))
          .orderBy(asc(shopProductImages.position));

  return {
    currency: settings?.currency ?? "usd",
    open: settings?.chargesEnabled ?? false,
    fulfilment: settings?.fulfilment === "pickup" ? "pickup" : "ship",
    shippingCents: settings?.shippingCents ?? 0,
    shippingPolicy: settings?.shippingPolicy ?? null,
    refundPolicy: settings?.refundPolicy ?? null,
    products: products.map((p) => {
      const count = images.filter((i) => i.productPublicId === p.publicId).length;
      return {
        id: p.publicId,
        name: p.name,
        slug: p.slug,
        description: p.description,
        priceCents: p.priceCents,
        available: p.stock === null ? null : Math.max(0, p.stock - p.reserved),
        images: Array.from({ length: count }, (_, index) => imageUrl(p.publicId, index)),
      };
    }),
  };
}

/**
 * The bytes behind one feed image URL. Null for anything a visitor should
 * not see: a hidden or deleted product, a trashed or unready photo, an
 * index past the end. The index counts visible images only, in the order
 * the client set, so it matches what the feed numbered.
 */
export async function findProductImage(
  db: Database,
  sitePublicId: string,
  productPublicId: string,
  index: number,
  kind: (typeof IMAGE_KINDS)[ProductImageSize] = PRODUCT_IMAGE_KIND,
): Promise<{ storageKey: string; contentType: string; byteSize: number } | null> {
  if (!Number.isInteger(index) || index < 0) return null;
  const rows = await db
    .select({
      storageKey: mediaDerivatives.storageKey,
      contentType: mediaDerivatives.contentType,
      byteSize: mediaDerivatives.byteSize,
    })
    .from(shopProductImages)
    .innerJoin(shopProducts, eq(shopProducts.id, shopProductImages.productId))
    .innerJoin(sites, eq(sites.id, shopProducts.siteId))
    .innerJoin(mediaAssets, eq(mediaAssets.id, shopProductImages.assetId))
    .innerJoin(mediaDerivatives, and(eq(mediaDerivatives.assetId, mediaAssets.id), eq(mediaDerivatives.kind, kind)))
    .where(visibleImage(sitePublicId, productPublicId))
    .orderBy(asc(shopProductImages.position))
    .limit(1)
    .offset(index);
  return rows[0] ?? null;
}
