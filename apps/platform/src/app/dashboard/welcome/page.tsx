import Link from "next/link";
import { redirect } from "next/navigation";
import { BUILD, GROWTH_FEATURES } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getWelcomeOffer, type WelcomeOffer } from "@/db/repositories/client/onboarding-checkout";
import { ordinal } from "@/lib/billing/billing-day";
import { formatMoney, type SiteDue } from "@/lib/onboarding/checkout";
import { buildVenmoPaymentUrl, configuredVenmoHandle } from "@/lib/payments/venmo";
import { formatDate } from "@/lib/time";
import { PayPanel } from "../billing/pay-panel";
import { WelcomeCheckout, type WelcomePlan } from "./welcome-checkout";
import "./welcome.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Welcome",
  robots: { index: false, follow: false },
};

/**
 * The welcome checkout: where a client lands after choosing their first
 * password, and where "Pay for your website" on Get started leads.
 *
 * One page for the three things the operator wants settled at the start —
 * paying for the site, a care plan if they want one, and any Growth add-ons —
 * with the total in view and one button to Stripe (`onboarding-checkout.ts`
 * explains how one checkout carries all three). Nothing is charged here.
 *
 * A client with nothing to pay and nothing to choose — on the house, or
 * already paying by card — goes straight on to Get started.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ first?: string; plan?: string; addons?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const db = await getDb();
  const offer = await getWelcomeOffer(db, tenantContextFrom(user, user.organizationId));
  if (!offer) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to a client record yet. Please contact us.</p>
      </main>
    );
  }
  if (!offer.plans && offer.siteDue.kind === "none") redirect("/dashboard/get-started");

  const params = await searchParams;
  const firstVisit = params.first === "1";
  const plans: WelcomePlan[] = (offer.plans ?? []).map((plan) => ({
    key: plan.key,
    name: plan.name,
    monthlyCents: plan.monthlyCents,
    description: plan.description,
    features: plan.features,
    recommended: plan.recommended,
    featured: plan.featured,
  }));
  // Back from Stripe's page with what they had chosen; otherwise the plan an
  // operator agreed with them, if any. Anything unknown in the URL is ignored.
  const fromUrl = plans.find((p) => p.key === params.plan)?.key ?? null;
  const initialPlanKey = fromUrl ?? plans.find((p) => p.recommended)?.key ?? null;
  const initialAddOns = (params.addons ?? "")
    .split(",")
    .filter((key) => GROWTH_FEATURES.some((f) => f.key === key));

  return (
    <main className="shell welcome">
      <div className="masthead">
        <h1>{firstVisit ? "Welcome to your portal" : "Your website, plan and add-ons"}</h1>
        <span>{offer.businessName}</span>
      </div>
      <p className="page-intro">
        {firstVisit
          ? "Your password is set. Next, pay for your website and pick any extras. Everything after the website is optional, and you can change it later."
          : "Pay for your website and pick any extras. Everything after the website is optional."}
      </p>

      <WelcomeCheckout
        siteSection={<SiteSection offer={offer} />}
        siteDue={offer.siteDue}
        plans={offer.plans ? plans : null}
        currentPlanName={offer.currentPlanName}
        initialPlanKey={initialPlanKey}
        initialAddOns={initialAddOns}
        stripeReady={offer.stripeReady}
        billingDayLabel={offer.billingDay ? ordinal(offer.billingDay) : null}
        promo={offer.promo}
      />
    </main>
  );
}

/** Paying for the site: the build at its published price, an invoice we raised, or nothing. */
function SiteSection({ offer }: { offer: WelcomeOffer }) {
  const due = offer.siteDue;
  if (due.kind === "none") {
    return (
      <p className="notice notice-success">
        {due.reason === "paid" ? (
          <>
            <strong>Your website is paid for.</strong> Thank you.
          </>
        ) : (
          <strong>There&rsquo;s nothing to pay for your website.</strong>
        )}
      </p>
    );
  }

  return (
    <section className="panel" aria-labelledby="welcome-site">
      <div className="panel-head">
        <h2 id="welcome-site">Your website</h2>
        <span className="panel-sub">{due.kind === "build" ? "Paid once" : `Invoice ${due.reference}`}</span>
      </div>
      <div className="panel-body">
        {due.kind === "build" ? <BuildDetail amountCents={due.amountCents} /> : <InvoiceDetail due={due} offer={offer} />}
      </div>
    </section>
  );
}

function BuildDetail({ amountCents }: { amountCents: number }) {
  return (
    <div className="welcome-build">
      <p className="welcome-build-price">
        <strong>{formatMoney(amountCents)}</strong>
        <span>for the design and build</span>
      </p>
      <ul className="plan-features">
        {BUILD.includes.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function InvoiceDetail({ due, offer }: { due: Extract<SiteDue, { kind: "invoice" }>; offer: WelcomeOffer }) {
  const handle = configuredVenmoHandle();
  const venmoUrl = handle
    ? buildVenmoPaymentUrl({
        handle,
        amountCents: due.amountCents,
        reference: due.reference,
        businessName: offer.businessName,
      })
    : null;

  return (
    <div className="welcome-invoice">
      <p className="welcome-build-price">
        <strong>{formatMoney(due.amountCents)}</strong>
        <span>{due.note ?? "For your website"}</span>
      </p>
      <p className="muted">
        {due.dueOn ? `Due ${formatDate(new Date(`${due.dueOn}T12:00:00Z`))}. ` : ""}Paid on its own, separately from
        a plan.
        {due.others > 0 && (
          <>
            {" "}
            You have {due.others} more on <Link href="/dashboard/billing">Billing</Link>.
          </>
        )}
      </p>
      {due.status === "awaiting_confirmation" ? (
        <p className="notice notice-success">
          <strong>You&rsquo;ve told us this is paid.</strong> We&rsquo;ll confirm it shortly.
        </p>
      ) : (
        <PayPanel
          requestPublicId={due.publicId}
          venmoUrl={venmoUrl}
          cardAvailable={offer.stripeReady}
          reference={due.reference}
          amount={formatMoney(due.amountCents)}
        />
      )}
    </div>
  );
}
