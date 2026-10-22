import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getPlanChoice } from "@/db/repositories/client/plan-choice";
import { getCart } from "@/db/repositories/client/cart";
import { ordinal } from "@/lib/billing/billing-day";
import { PlanPicker } from "./plan-picker";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Choose your plan",
  robots: { index: false, follow: false },
};

/**
 * Choosing a care plan and setting up automatic payment.
 *
 * A client lands here straight after choosing their password, and can come
 * back from Billing. Nothing is charged by choosing: the button opens Stripe's
 * checkout, and only a paid invoice arriving by webhook puts money in the
 * ledger. A client with nothing to choose — a free plan, or already paying —
 * is sent on to their site rather than shown plans they cannot buy, and one
 * whose website is unpaid is sent to the cart.
 */
export default async function ChoosePlanPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const db = await getDb();
  const ctx = tenantContextFrom(user, user.organizationId);
  // A client who has not paid for their website pays for it and chooses a
  // plan in one checkout. A plan on its own from here would skip the build.
  if ((await getCart(db, ctx)).open) redirect("/dashboard/cart");
  const choice = await getPlanChoice(db, ctx);
  if (!choice.open) redirect(choice.reason === "subscribed" ? "/dashboard/billing" : "/dashboard");

  const { welcome } = await searchParams;
  const firstVisit = welcome === "1";

  return (
    <main className="shell">
      <div className="masthead">
        <h1>{firstVisit ? "Welcome. Choose your plan" : "Choose your plan"}</h1>
      </div>
      <p className="page-intro">
        Every plan includes hosting, security updates and your visitor numbers. They differ in how
        many changes we make for you each month. You can move up or down later.
      </p>

      <PlanPicker plans={choice.plans} />

      <p className="muted plan-footnote">
        You&rsquo;ll enter your card on Stripe&rsquo;s secure page, not here.{" "}
        {choice.billingDay
          ? `Payments come out on the ${ordinal(choice.billingDay)} of each month; the first one covers the days until then.`
          : "Payments come out on the same day each month, starting today."}{" "}
        Cancel any time from Billing.
      </p>
      <p className="plan-footnote">
        <Link href="/dashboard">{firstVisit ? "I’ll choose later" : "Back to your site"}</Link>
      </p>
    </main>
  );
}
