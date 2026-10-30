import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { getShopSettings, type ShopSettingsView } from "@/db/repositories/client/shop-settings";
import { countOrdersAwaitingShipment } from "@/db/repositories/client/shop-orders";
import { listProducts, type ProductSummary } from "@/db/repositories/client/shop-products";
import { getShopSales } from "@/db/repositories/client/shop-sales";
import { stripeConfigured } from "@/lib/payments/stripe";
import { money } from "@/lib/shop/money";
import { stockLabel } from "@/lib/shop/products";
import { SalesPanel, type SalesState } from "./sales-panel";
import "./shop.css";

/**
 * The shop, from the client's side: how to get it going, what is selling,
 * and the products.
 *
 * Written for the store owner, not the operator. Until the shop can take a
 * payment with something on the website, the setup steps come first; after
 * that the sales do, and the steps get out of the way.
 */

const SETTINGS_PATH = "/dashboard/growth/shop/settings";
const NEW_PRODUCT_PATH = "/dashboard/growth/shop/products/new";

/** Read separately so a failed figure costs the panel, not the page. */
async function salesState(load: () => ReturnType<typeof getShopSales>): Promise<SalesState> {
  try {
    return { kind: "ready", sales: await load() };
  } catch (error) {
    console.error("[shop] sales summary failed", { message: error instanceof Error ? error.message : "unknown" });
    return { kind: "failed" };
  }
}

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

  const [settings, products, toSend, sales, { deleted }] = await Promise.all([
    getShopSettings(db, ctx),
    listProducts(db, ctx),
    countOrdersAwaitingShipment(db, ctx),
    salesState(() => getShopSales(db, ctx)),
    searchParams,
  ]);
  const readOnly = ctx.impersonating;
  const onSite = products.filter((p) => p.status === "active").length;
  const setUp = settings !== null && settings.chargesEnabled && settings.updatedAt !== null && onSite > 0;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Shop</h1>
        <span>Sell what you make from the website you already have</span>
      </div>

      {deleted === "1" && <p className="notice notice-success">Deleted. It is off your website; orders already placed keep it.</p>}

      {!settings ? (
        <section className="panel">
          <div className="panel-body">
            <p>Your shop goes on your website, and there is no website on your account yet. It appears here once there is.</p>
          </div>
        </section>
      ) : setUp ? (
        <>
          <SalesPanel state={sales} toSend={toSend} chargesEnabled={settings.chargesEnabled} onSite={onSite} />
          <ProductsPanel products={products} readOnly={readOnly} />
          <p className="panel-note">
            Payments, shipping and your returns policy are in <Link href={SETTINGS_PATH}>Shop settings</Link>.
          </p>
        </>
      ) : (
        <>
          <SetupPanel settings={settings} products={products} onSite={onSite} />
          <SalesPanel state={sales} toSend={toSend} chargesEnabled={settings.chargesEnabled} onSite={onSite} />
          <ProductsPanel products={products} readOnly={readOnly} />
        </>
      )}
    </main>
  );
}

function fulfilmentSummary(settings: ShopSettingsView): string {
  if (settings.fulfilment === "pickup") return "Customers collect their order from you.";
  if (settings.shippingCents === 0) return "You ship orders, free of charge.";
  return `You ship orders, ${money(settings.shippingCents)} per order.`;
}

/**
 * Four things to do once. Each step says what it is for, in the owner's
 * terms, and links to where it is done.
 */
function SetupPanel({
  settings,
  products,
  onSite,
}: {
  settings: ShopSettingsView;
  products: ProductSummary[];
  onSite: number;
}) {
  const paid = settings.chargesEnabled;
  const fulfilmentDone = settings.updatedAt !== null;

  return (
    <section className="panel" aria-labelledby="shop-setup">
      <div className="panel-head">
        <h2 id="shop-setup">Set up your shop</h2>
        <span className="panel-sub">On {settings.siteName}</span>
      </div>
      <div className="panel-body">
        <p className="shop-setup-intro">
          Do these once. After that, anything you add here shows in the shop on your website by itself, and every sale
          shows up on this page.
        </p>
        <ol className="shop-steps">
          <Step n={1} done={paid} title="Connect Stripe, so customers can pay you">
            <PaymentsStep settings={settings} />
          </Step>
          <Step n={2} done={fulfilmentDone} title="Choose shipping or pickup">
            {fulfilmentDone ? (
              <p className="muted">
                {fulfilmentSummary(settings)} <Link href={SETTINGS_PATH}>Change</Link>
              </p>
            ) : (
              <p>
                How orders reach customers, and what you tell them about returns.{" "}
                <Link href={SETTINGS_PATH}>Choose</Link>
              </p>
            )}
          </Step>
          <Step n={3} done={products.length > 0} title="Add your products">
            {products.length === 0 ? (
              <p>
                A photo or two, a price and how many you have. <Link href={NEW_PRODUCT_PATH}>Add your first product</Link>
              </p>
            ) : (
              <p className="muted">
                {products.length === 1 ? "1 product added." : `${products.length} products added.`}{" "}
                <Link href={NEW_PRODUCT_PATH}>Add another</Link>
              </p>
            )}
          </Step>
          <Step n={4} done={onSite > 0} title="Put them on your website">
            <OnSiteStep products={products.length} onSite={onSite} paid={paid} />
          </Step>
        </ol>
      </div>
    </section>
  );
}

function PaymentsStep({ settings }: { settings: ShopSettingsView }) {
  if (settings.chargesEnabled) {
    return <p className="muted">Connected. Every sale is paid into your own Stripe account.</p>;
  }
  if (settings.stripeAccountId) {
    return (
      <p>
        Stripe needs a few more details before it will take payments. <Link href={SETTINGS_PATH}>Finish with Stripe</Link>
      </p>
    );
  }
  if (!stripeConfigured()) {
    return (
      <p>
        Connecting Stripe is not switched on yet; we will let you know when it is. You can do the other steps in the
        meantime.
      </p>
    );
  }
  return (
    <p>
      Customers pay by card through Stripe, into an account in your name. We never hold your money.{" "}
      <Link href={SETTINGS_PATH}>Connect Stripe</Link>
    </p>
  );
}

function OnSiteStep({ products, onSite, paid }: { products: number; onSite: number; paid: boolean }) {
  if (onSite === 0) {
    return (
      <p>
        {products === 0
          ? "New products stay off your website until you are happy with them. Then press \u201cPut on my website\u201d on one."
          : "Open a product below and press \u201cPut on my website\u201d."}{" "}
        It appears in the shop on your website straight away. No request needed.
      </p>
    );
  }
  if (paid) {
    return (
      <p className="muted">
        {onSite} of {products} on your website, ready to buy.
      </p>
    );
  }
  return (
    <p>
      {onSite} of {products} on your website. Customers can see {onSite === 1 ? "it" : "them"}; the Buy button
      appears once Stripe is connected.
    </p>
  );
}

function ProductsPanel({ products, readOnly }: { products: ProductSummary[]; readOnly: boolean }) {
  return (
    <section className="panel" aria-labelledby="shop-products">
      <div className="panel-head">
        <h2 id="shop-products">Products</h2>
        {!readOnly && (
          <div className="panel-head-actions">
            <Link className="button small" href={NEW_PRODUCT_PATH}>
              Add a product
            </Link>
          </div>
        )}
      </div>
      <div className="panel-body">
        {products.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No products yet. Each one you add is listed here, with whether it is on your website.
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
