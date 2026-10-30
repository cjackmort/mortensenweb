import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { listAssets } from "@/db/repositories/client/media-assets";
import { getProduct, type ProductDetail } from "@/db/repositories/client/shop-products";
import { isValidPublicId, normalisePublicId } from "@/lib/ids";
import { money } from "@/lib/shop/money";
import { describeProductEvent, MAX_PRODUCT_PHOTOS, stockLabel } from "@/lib/shop/products";
import { formatDateTime } from "@/lib/time";
import { DeleteButton, StatusToggle } from "../product-controls";
import { ProductForm } from "../product-form";
import { pickablePhotos, PICKER_LIMIT } from "../pickable";
import "../../shop.css";

/**
 * One product: its details and photos to change, whether it is on the
 * website, and everything that has happened to it. A product from another
 * tenant, or one that never existed, is a 404 — the same 404.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Product",
  robots: { index: false, follow: false },
};

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ added?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) redirect("/dashboard/growth?locked=shop#shop");

  const { publicId: raw } = await params;
  if (!isValidPublicId(raw)) notFound();
  const publicId = normalisePublicId(raw);

  let product: ProductDetail;
  try {
    product = await getProduct(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [assets, { added }] = await Promise.all([listAssets(db, ctx, { limit: PICKER_LIMIT }), searchParams]);
  const readOnly = ctx.impersonating;
  const active = product.status === "active";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{product.name}</h1>
      </div>

      {added === "1" && !product.deleted && (
        <p className="notice notice-success">Added. Check it over, then put it on your website below.</p>
      )}

      {product.deleted ? (
        <section className="panel">
          <div className="panel-body">
            <p>This product was deleted. It is off your website, and orders already placed keep it.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="panel" aria-labelledby="product-site">
            <div className="panel-head">
              <h2 id="product-site">On your website</h2>
              <span className={`pill ${active ? "pill-success" : "pill-neutral"}`}>{active ? "On the site" : "Not on the site"}</span>
            </div>
            <div className="panel-body">
              <p className="shop-status">
                <span>{money(product.priceCents)}</span>
                <span className="muted">{stockLabel(product.stock, product.reserved)}</span>
              </p>
              <p className="muted">
                {active
                  ? "Customers can buy this now. Changes you save here show on the site within a minute."
                  : "Nobody can see or buy this until you put it on your website."}
              </p>
              <StatusToggle publicId={product.publicId} active={active} readOnly={readOnly} />
            </div>
          </section>

          <ProductForm product={product} photos={pickablePhotos(assets)} maxPhotos={MAX_PRODUCT_PHOTOS} readOnly={readOnly} />
        </>
      )}

      <section className="panel" aria-labelledby="product-history">
        <div className="panel-head">
          <h2 id="product-history">History</h2>
        </div>
        <div className="panel-body">
          <ul className="shop-history">
            {product.history.map((event, i) => (
              <li key={`${event.createdAt.toISOString()}-${i}`}>
                <span>{describeProductEvent(event.action, event.changes)}</span>
                <span className="muted">{formatDateTime(event.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {!product.deleted && (
        <div className="shop-danger">
          <DeleteButton publicId={product.publicId} name={product.name} readOnly={readOnly} />
        </div>
      )}
    </main>
  );
}
