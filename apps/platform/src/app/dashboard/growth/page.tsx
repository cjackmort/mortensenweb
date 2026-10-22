import Link from "next/link";
import { redirect } from "next/navigation";
import { ADS_AVAILABLE, dollars, feeTermsLabel, type GrowthFeatureKey } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getGrowthState } from "@/db/repositories/client/growth";
import type { FeatureAccess } from "@/lib/growth/access";
import { addAddOnAction } from "../plan/actions";
import { PlanActionButton } from "../plan/controls";
import { CreateAdButton } from "@/components/ads/create-ad-button";
import "@/components/ads/ads.css";

/**
 * The Growth tab: every tool that brings a client more customers, in one
 * place, whether they have it or not.
 *
 * What they have opens. What they do not is shown as a blurred preview with
 * what it does and what it does *for the business*, and the two ways to get
 * it — add it on its own, or move to the plan that includes it, with the
 * saving said out loud when the plan is the better deal. A feature that is not
 * built yet says so and offers nothing to buy.
 *
 * Which is which is decided in `lib/growth/access.ts`, never here.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Growth",
  robots: { index: false, follow: false },
};

/** Where an owned, built feature opens. */
const OPENS: Partial<Record<GrowthFeatureKey, string>> = {
  leads: "/dashboard/growth/leads",
  campaigns: "/dashboard/growth/campaigns",
  reviews: "/dashboard/growth/reviews",
  winback: "/dashboard/growth/winback",
  showcase: "/dashboard/growth/showcase",
};

const VIA_LABEL = {
  comp: "On the house",
  plan: "In your plan",
  "add-on": "Add-on",
} as const;

export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ locked?: string }>;
}) {
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
  const state = await getGrowthState(db, ctx);
  const { locked } = await searchParams;
  const lockedName = state.access.find((a) => a.feature.key === locked)?.feature.name;

  const owned = state.access.filter((a) => a.via);
  const notOwned = state.access.filter((a) => !a.via);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Growth</h1>
        <span>Tools that bring you more customers</span>
      </div>

      {lockedName && (
        <p className="notice notice-info">
          {lockedName} is not part of your plan yet — here is how to add it.
        </p>
      )}

      {ADS_AVAILABLE && <AdsCard readOnly={ctx.impersonating} />}

      {owned.length > 0 && (
        <section aria-labelledby="growth-yours">
          <h2 id="growth-yours" className="growth-heading">Yours</h2>
          <div className="growth-grid">
            {owned.map((a) => (
              <FeatureCard key={a.feature.key} access={a} state={state} />
            ))}
          </div>
        </section>
      )}

      {notOwned.length > 0 && (
        <section aria-labelledby="growth-more">
          <h2 id="growth-more" className="growth-heading">
            {owned.length > 0 ? "Add more" : "What Growth can do for you"}
          </h2>
          <div className="growth-grid">
            {notOwned.map((a) => (
              <FeatureCard key={a.feature.key} access={a} state={state} />
            ))}
          </div>
        </section>
      )}

      <p className="panel-note">
        Want to compare plans, change yours or cancel? It is all under{" "}
        <Link href="/dashboard/plan">Plan</Link>.
      </p>
    </main>
  );
}

function FeatureCard({
  access,
  state,
}: {
  access: FeatureAccess;
  state: Awaited<ReturnType<typeof getGrowthState>>;
}) {
  const { feature, via, upgradeTo, upgradeSavesCents, canAdd } = access;
  const opens = OPENS[feature.key];
  const teaser =
    feature.key === "leads" && !via && state.waitingLeads > 0
      ? `${state.waitingLeads} ${state.waitingLeads === 1 ? "enquiry is" : "enquiries are"} waiting for you.`
      : null;

  if (via) {
    return (
      <article className="card growth-card" id={feature.key}>
        <div className="card-head">
          <h3>{feature.name}</h3>
          <span className="pill pill-success">{VIA_LABEL[via]}</span>
        </div>
        <p>{feature.summary}</p>
        {feature.available && opens ? (
          <Link className="button" href={opens}>
            Open {feature.name.toLowerCase()}
          </Link>
        ) : (
          <p className="muted growth-soon">Coming soon — it switches on here the day it is ready.</p>
        )}
      </article>
    );
  }

  return (
    <article className="card growth-card growth-card--locked" id={feature.key}>
      {/* A suggestion of the tool, not a real one: decorative, and blurred so
          nobody mistakes it for something they can use. */}
      <div className="growth-preview" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="card-head">
        <h3>{feature.name}</h3>
        <span className={`pill ${feature.available ? "pill-neutral" : "pill-info"}`}>
          {feature.available ? "Not in your plan" : "Coming soon"}
        </span>
      </div>
      <p>{feature.summary}</p>
      <p className="growth-benefit">{feature.benefit}</p>
      {teaser && <p className="notice notice-info">{teaser}</p>}

      {feature.available ? (
        <div className="growth-actions">
          {canAdd && state.billing === "stripe" ? (
            <PlanActionButton
              action={addAddOnAction}
              fields={{ feature: feature.key }}
              label={`Add for ${dollars(feature.addOnCents)}/month`}
              pendingLabel="Adding…"
              confirm={`Add ${feature.name} for ${dollars(feature.addOnCents)} a month? It starts now and is added to your next payment.`}
            />
          ) : null}
          <Link className="button secondary" href="/dashboard/plan#plans">
            Get it with {upgradeTo.name} — {dollars(upgradeTo.monthlyCents)}/month
          </Link>
          {upgradeSavesCents ? (
            <p className="hint growth-saving">
              {upgradeTo.name} includes this and more, and costs {dollars(upgradeSavesCents)} a month less
              than adding its tools one by one.
            </p>
          ) : null}
          {state.billing !== "stripe" && canAdd ? (
            <p className="hint">
              To add it, <Link href="/dashboard/requests">send us a request</Link> and we will set it up.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted growth-soon">
          We are building this now. It will be included in {upgradeTo.name} and above.
        </p>
      )}
    </article>
  );
}

/**
 * Ads sit above the plan features because they are on every plan: the client
 * pays per campaign, so there is nothing to unlock and no upgrade to offer.
 */
function AdsCard({ readOnly }: { readOnly: boolean }) {
  return (
    <section className="card growth-card" id="ads" aria-labelledby="growth-ads">
      <div className="card-head">
        <h2 id="growth-ads">Ads on Google, Facebook and Instagram</h2>
        <span className="pill pill-success">On every plan</span>
      </div>
      <p>
        We draft the ad from your business information. You choose where it runs and how much to spend, and pay once
        per campaign: the ad spend at cost, plus our fee ({feeTermsLabel()}) on its own line.
      </p>
      <div className="request-cta-actions ad-card-actions">
        {!readOnly && <CreateAdButton />}
        <Link className="button secondary" href="/dashboard/growth/ads">
          See your ads
        </Link>
      </div>
    </section>
  );
}
