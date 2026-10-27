import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { getShopSettings, type ShopSettingsView } from "@/db/repositories/client/shop-settings";
import { listProducts, type ProductSummary } from "@/db/repositories/client/shop-products";
import { money } from "@/lib/shop/money";
import { stockLabel } from "@/lib/shop/products";
import "./shop.css";

/**
 * The shop, from the client's side: what is set up, and the products.
 *
 * Orders arrive here when checkout is built. Until then the page never shows
 * an order count, which would read as a shop nobody has bought from rather
 * than one that cannot sell yet.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shop",
  robots: { index: false, follow: false },
};

export default async function ShopPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) redirect("/dashboard/growth?locked=shop#shop");

  const [settings, products, { deleted }] = await Promise.all([getShopSettings(db, ctx), listProducts(db, ctx), searchParams]);
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Shop</h1>
        <span>Sell what you make from the website you already have</span>
      </div>

      {deleted === "1" && <p className="notice notice-success">Deleted. It is off your website; orders already placed keep it.</p>}

      {settings ? (
        <>
          <SetupPanel settings={settings} products={products} />
          <ProductsPanel products={products} readOnly={readOnly} />
        </>
      ) : (
        <section className="panel">
          <div className="panel-body">
            <p>Your shop goes on your website, and there is no website on your account yet. It appears here once there is.</p>
          </div>
        </section>
      )}

      <p className="panel-note">
        <Link href="/dashboard/growth">← Growth</Link>
      </p>
    </main>
  );
}

function SetupPanel({ settings, products }: { settings: ShopSettingsView; products: ProductSummary[] }) {
  const paymentsDone = settings.chargesEnabled;
  const fulfilmentDone = settings.updatedAt !== null;
  const onSite = products.filter((p) => p.status === "active").length;

  return (
    <section className="panel" aria-labelledby="shop-setup">
      <div className="panel-head">
        <h2 id="shop-setup">Getting set up</h2>
        <span className="panel-sub">On {settings.siteName}</span>
      </div>
      <div className="panel-body">
        <ol className="shop-steps">
          <Step n={1} done={paymentsDone} title="Connect Stripe">
            {paymentsDone ? (
              <p className="muted">Connected. Payments go straight to your Stripe account.</p>
            ) : settings.stripeAccountId ? (
              <p>
                Stripe still needs a few details before it will take payments.{" "}
                <Link href="/dashboard/growth/shop/settings">Finish setting up</Link>
              </p>
            ) : (
              <p>
                Customers pay through Stripe, into an account in your name.{" "}
                <Link href="/dashboard/growth/shop/settings">Connect Stripe</Link>
              </p>
            )}
          </Step>
          <Step n={2} done={fulfilmentDone} title="Say how orders reach customers">
            {fulfilmentDone ? (
              <p className="muted">
                {settings.fulfilment === "pickup"
                  ? "Customers collect their order."
                  : settings.shippingCents === 0
                    ? "Shipped, free of charge."
                    : `Shipped, ${money(settings.shippingCents)} per order.`}{" "}
                <Link href="/dashboard/growth/shop/settings">Change</Link>
              </p>
            ) : (
              <p>
                Shipping or pickup, and what you tell customers about returns.{" "}
                <Link href="/dashboard/growth/shop/settings">Choose</Link>
              </p>
            )}
          </Step>
          <Step n={3} done={onSite > 0} title="Put products on your website">
            {products.length === 0 ? (
              <p>
                Photos, a price and how many you have. <Link href="/dashboard/growth/shop/products/new">Add your first product</Link>
              </p>
            ) : onSite === 0 ? (
              <p>
                {products.length === 1 ? "Your product is" : `Your ${products.length} products are`} added but not on the website yet.
                Open one below and put it on.
              </p>
            ) : (
              <p className="muted">
                {onSite} of {products.length} on your website.
              </p>
            )}
          </Step>
        </ol>
      </div>
    </section>
  );
}

function ProductsPanel({ products, readOnly }: { products: ProductSummary[]; readOnly: boolean }) {
  return (
    <section className="panel" aria-labelledby="shop-products">
      <div className="panel-head">
        <h2 id="shop-products">Products</h2>
        {!readOnly && (
          <div className="panel-head-actions">
            <Link className="button small" href="/dashboard/growth/shop/products/new">
              Add a product
            </Link>
          </div>
        )}
      </div>
      <div className="panel-body">
        {products.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No products yet.
          </p>
        ) : (
          <ul className="shop-products">
            {products.map((product) => (
              <li key={product.publicId}>
                <Link href={`/dashboard/growth/shop/products/${product.publicId}`} className="shop-product-row">
                  {product.coverAssetPublicId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="shop-product-cover" src={`/api/media/assets/${product.coverAssetPublicId}/thumb`} alt="" loading="lazy" />
                  ) : (
                    <span className="shop-product-cover" aria-hidden="true" />
                  )}
                  <span>
                    <span className="shop-product-name">{product.name}</span>
                    <span className="shop-product-meta">
                      {money(product.priceCents)} · {stockLabel(product.stock, product.reserved)}
                      {product.photoCount === 0 ? " · No photo" : ""}
                    </span>
                  </span>
                  <span className={`pill ${product.status === "active" ? "pill-success" : "pill-neutral"}`}>
                    {product.status === "active" ? "On the site" : "Not on the site"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={`shop-step${done ? " shop-step--done" : ""}`}>
      <span className="shop-step-mark" aria-hidden="true">
        {done ? "✓" : n}
      </span>
      <div>
        <strong>{title}</strong>
        {done && <span className="visually-hidden"> (done)</span>}
        {children}
      </div>
    </li>
  );
}
