import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import {
  getShopSettings,
  refreshStripeAccount,
  type ShopSettingsView,
} from "@/db/repositories/client/shop-settings";
import { stripeConfigured } from "@/lib/payments/stripe";
import type { ConnectedAccountStatus } from "@/lib/shop/connect";
import { formatDateTime } from "@/lib/time";
import { ConnectStripeButton } from "../connect-button";
import { ShopSettingsForm } from "./settings-form";
import "../shop.css";

/**
 * Where the money goes and how orders get to people.
 *
 * Stripe sends the client back here after onboarding (`?stripe=return`) and
 * when an onboarding link has expired (`?stripe=refresh`). Coming back proves
 * nothing, so the page re-reads the account from Stripe and reports what it
 * actually says.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shop settings",
  robots: { index: false, follow: false },
};

export default async function ShopSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) redirect("/dashboard/growth?locked=shop#shop");

  const { stripe: cameFrom } = await searchParams;
  // The one write a GET does: mirroring what Stripe says, which the webhook
  // would do anyway. Only on the way back from Stripe, so refreshing the page
  // is not an API call each time.
  const returned = cameFrom === "return" ? await refreshStripeAccount(db, ctx) : null;

  const settings = await getShopSettings(db, ctx);
  if (!settings) redirect("/dashboard/growth/shop");
  const readOnly = ctx.impersonating;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          Shop<span className="masthead-sub">Settings</span>
        </h1>
      </div>

      {cameFrom === "refresh" && (
        <p className="notice notice-warning">That Stripe link had expired. Press the button again to carry on.</p>
      )}
      {cameFrom === "return" && <ReturnNotice status={returned} />}

      <section className="panel" aria-labelledby="shop-payments">
        <div className="panel-head">
          <h2 id="shop-payments">Payments</h2>
          <PaymentsPill settings={settings} />
        </div>
        <div className="panel-body">
          <Payments settings={settings} readOnly={readOnly} />
        </div>
      </section>

      <section className="panel" aria-labelledby="shop-orders">
        <div className="panel-head">
          <h2 id="shop-orders">Orders</h2>
          {settings.updatedAt && <span className="panel-sub">Saved {formatDateTime(settings.updatedAt)}</span>}
        </div>
        <div className="panel-body">
          <ShopSettingsForm settings={settings} readOnly={readOnly} />
        </div>
      </section>
    </main>
  );
}

function PaymentsPill({ settings }: { settings: ShopSettingsView }) {
  if (settings.chargesEnabled) return <span className="pill pill-success">Connected</span>;
  if (settings.stripeAccountId) return <span className="pill pill-warning">Finishing setup</span>;
  return <span className="pill pill-neutral">Not connected</span>;
}

function Payments({ settings, readOnly }: { settings: ShopSettingsView; readOnly: boolean }) {
  if (settings.chargesEnabled) {
    return (
      <>
        <p className="shop-status">
          <span>Payments go to your Stripe account</span>
          <code>{settings.stripeAccountId}</code>
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Payouts, receipts and refunds are in your own Stripe dashboard. To move the shop to a different Stripe
          account, ask us.
        </p>
      </>
    );
  }

  if (!stripeConfigured()) {
    return <p className="muted" style={{ margin: 0 }}>Connecting Stripe is not switched on here yet. We will let you know when it is.</p>;
  }

  if (settings.stripeAccountId) {
    return (
      <>
        <p>
          Your Stripe account is created, but Stripe still needs some details before it will take payments. Carry on
          where you left off.
        </p>
        <ConnectStripeButton label="Continue with Stripe" readOnly={readOnly} />
      </>
    );
  }

  return (
    <>
      <p>
        Customers pay through Stripe. You set up a Stripe account in your own name, with your own bank, and every sale
        is paid into it. We never hold your money and never see a card.
      </p>
      <p className="muted">
        Stripe takes its card fee out of each sale; the rest is paid out to you on Stripe&apos;s schedule. Have your
        business details and bank account to hand: it takes about ten minutes.
      </p>
      <ConnectStripeButton label="Connect Stripe" readOnly={readOnly} />
    </>
  );
}

function ReturnNotice({ status }: { status: ConnectedAccountStatus | null }) {
  if (!status) {
    return (
      <p className="notice notice-warning">
        We could not check your Stripe account just now. Reload this page in a minute.
      </p>
    );
  }
  if (status.chargesEnabled) {
    return <p className="notice notice-success">Stripe is connected. Your shop can take payments.</p>;
  }
  if (status.detailsSubmitted) {
    return (
      <p className="notice notice-info">
        Stripe has your details and is checking them. Payments switch on here as soon as it is done, usually within a
        day.
      </p>
    );
  }
  return (
    <p className="notice notice-info">
      Stripe is waiting for a few more details. Press &ldquo;Continue with Stripe&rdquo; to finish.
    </p>
  );
}
