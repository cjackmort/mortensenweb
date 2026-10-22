import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getCart } from "@/db/repositories/client/cart";
import { businessTimeZone } from "@/lib/time";
import { CartForm } from "./cart-form";
import "./cart.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
};

/**
 * Paying for the website, and choosing a plan and Growth tools beside it.
 *
 * A new client lands here straight after choosing their password, and can
 * come back from Billing until they have paid. Nothing is charged here: the
 * button opens Stripe's checkout, and only a paid checkout arriving by
 * webhook marks the website paid. A client with nothing to pay is sent on.
 */
export default async function CartPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string; checkout?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role === "admin") redirect("/admin");
  if (!user.organizationId) redirect("/dashboard");

  const db = await getDb();
  const cart = await getCart(db, tenantContextFrom(user, user.organizationId));
  const { welcome, checkout } = await searchParams;

  if (!cart.open) {
    if (cart.reason === "paid" || cart.reason === "subscribed") redirect("/dashboard/plan");
    if (cart.reason !== "no_build") redirect("/dashboard");
    return (
      <main className="shell">
        <div className="masthead">
          <h1>Your order</h1>
        </div>
        <p className="notice">
          We&rsquo;re still putting your website price together. We&rsquo;ll email you when it&rsquo;s ready.
        </p>
        <p>
          <Link href="/dashboard">Back to your site</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{welcome === "1" ? "Welcome. Here’s your order" : "Your order"}</h1>
      </div>
      <p className="page-intro">
        Your website is one payment. A monthly plan and Growth tools are optional, and you can add or cancel
        them later from the Plan tab.
      </p>
      {checkout === "cancelled" && (
        <p className="notice" role="status">
          Checkout was cancelled. Nothing was charged.
        </p>
      )}

      <CartForm
        catalog={cart.catalog}
        attachedPromo={cart.attachedPromo}
        now={new Date().toISOString()}
        timeZone={businessTimeZone()}
      />

      <p className="plan-footnote">
        <Link href="/dashboard">{welcome === "1" ? "I’ll do this later" : "Back to your site"}</Link>
      </p>
    </main>
  );
}
