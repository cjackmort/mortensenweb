import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { getShopSettings, type ShopSettingsView } from "@/db/repositories/client/shop-settings";
import "./shop.css";

/**
 * The shop, from the client's side.
 *
 * Products and orders arrive here as they are built. Until then the page is
 * the way in: what is set up, what is not, and where to do it. It never shows
 * an empty product grid or a zero-order count, which would read as a shop
 * nobody has bought from rather than one that does not exist yet.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shop",
  robots: { index: false, follow: false },
};

export default async function ShopPage() {
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

  const settings = await getShopSettings(db, ctx);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Shop</h1>
        <span>Sell what you make from the website you already have</span>
      </div>

      {settings ? (
        <SetupPanel settings={settings} />
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

function SetupPanel({ settings }: { settings: ShopSettingsView }) {
  const paymentsDone = settings.chargesEnabled;
  const fulfilmentDone = settings.updatedAt !== null;

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
                    : `Shipped, $${(settings.shippingCents / 100).toFixed(2)} per order.`}{" "}
                <Link href="/dashboard/growth/shop/settings">Change</Link>
              </p>
            ) : (
              <p>
                Shipping or pickup, and what you tell customers about returns.{" "}
                <Link href="/dashboard/growth/shop/settings">Choose</Link>
              </p>
            )}
          </Step>
          <Step n={3} done={false} title="Add your products">
            <p className="muted">We are building this now. Products, photos and stock will be added right here.</p>
          </Step>
        </ol>
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
