import Link from "next/link";
import { redirect } from "next/navigation";
import { GROWTH_FEATURES, PLANS, dollars } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getGrowthState } from "@/db/repositories/client/growth";
import { formatDate } from "@/lib/time";
import { addAddOnAction, cancellationAction, changePlanAction, removeAddOnAction } from "./actions";
import { PlanActionButton } from "./controls";

/**
 * The Plan tab: what the client is on, what it includes, and every way to
 * change it — another plan, an add-on, or cancelling.
 *
 * Self-serve only for a client paying by card, because that is the only case
 * where the portal can make the change itself. A client on the house already
 * has everything; one invoiced by hand is told how to ask. Payments and
 * invoices stay on Billing: this page is about what they get, not what they
 * have paid.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your plan",
  robots: { index: false, follow: false },
};

const BILLING_LABEL = {
  stripe: { text: "Paid by card", tone: "pill-success" },
  complimentary: { text: "Complimentary", tone: "pill-success" },
  invoiced: { text: "Invoiced", tone: "pill-neutral" },
  none: { text: "No plan yet", tone: "pill-warning" },
} as const;

export default async function PlanPage() {
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
  const plan = PLANS.find((p) => p.key === state.planKey) ?? null;
  const selfServe = state.billing === "stripe";
  const label = BILLING_LABEL[state.billing];
  const addable = state.access.filter((a) => a.canAdd);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Your plan</h1>
        <span>What you get, and changing it</span>
      </div>

      <section className="card" aria-labelledby="plan-current">
        <div className="card-head">
          <h2 id="plan-current">{state.planName ?? "No plan yet"}</h2>
          <span className={`pill ${label.tone}`}>{label.text}</span>
        </div>

        {state.billing === "complimentary" ? (
          <p>Your plan is on the house, and every Growth tool is included.</p>
        ) : state.monthlyPriceCents !== null ? (
          <p className="plan-price">
            {dollars(state.monthlyPriceCents)}
            <small> a month</small>
          </p>
        ) : null}

        {state.cancelsOn ? (
          <div className="notice notice-warning plan-cancelling">
            <p>
              Your plan ends on <strong>{formatDate(state.cancelsOn)}</strong>. Your website stays online
              after that; changes and Growth tools stop.
            </p>
            <PlanActionButton
              action={cancellationAction}
              fields={{ cancel: "0" }}
              label="Keep my plan"
              pendingLabel="Saving…"
            />
          </div>
        ) : state.renewsOn && selfServe ? (
          <p className="muted">Renews on {formatDate(state.renewsOn)}.</p>
        ) : null}

        {plan && (
          <>
            <h3>Included</h3>
            <ul className="plan-includes">
              {plan.features.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}

        {state.addOns.length > 0 && (
          <>
            <h3>Add-ons</h3>
            <ul className="plan-addons">
              {state.addOns.map((addOn) => {
                const feature = GROWTH_FEATURES.find((f) => f.key === addOn.featureKey)!;
                return (
                  <li key={addOn.featureKey}>
                    <span>
                      <strong>{feature.name}</strong>
                      {addOn.monthlyPriceCents !== null ? <> · {dollars(addOn.monthlyPriceCents)}/month</> : <> · added by us</>}
                    </span>
                    {selfServe && addOn.source === "stripe" ? (
                      <PlanActionButton
                        action={removeAddOnAction}
                        fields={{ feature: addOn.featureKey }}
                        label="Remove"
                        pendingLabel="Removing…"
                        variant="secondary"
                        confirm={`Remove ${feature.name}? You stop paying for it from your next payment and lose access now.`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <p className="panel-note">
          Payments and invoices are under <Link href="/dashboard/billing">Billing</Link>.
        </p>
      </section>

      <section className="card" id="plans" aria-labelledby="plan-change">
        <div className="card-head">
          <h2 id="plan-change">{state.billing === "none" ? "Choose a plan" : "Change plan"}</h2>
        </div>
        {state.billing === "complimentary" ? (
          <p className="muted">You already have everything — nothing to change.</p>
        ) : (
          <>
            <div className="plan-options">
              {PLANS.map((option) => {
                const current = option.key === plan?.key;
                return (
                  <div key={option.key} className={`plan-option${current ? " plan-option--current" : ""}`}>
                    <p className="plan-option-name">{option.name}</p>
                    <p className="plan-option-price">
                      {dollars(option.monthlyCents)}
                      <small>/month</small>
                    </p>
                    <p className="plan-option-desc">{option.description}</p>
                    {current ? (
                      <span className="pill pill-success">Your plan</span>
                    ) : selfServe ? (
                      <PlanActionButton
                        action={changePlanAction}
                        fields={{ plan: option.key }}
                        label={`Switch to ${option.name}`}
                        pendingLabel="Switching…"
                        variant={plan && option.monthlyCents < plan.monthlyCents ? "secondary" : "primary"}
                        confirm={`Switch to ${option.name} at ${dollars(option.monthlyCents)} a month? It applies now and your next payment is at the new price.`}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
            {state.billing === "none" ? (
              <p>
                <Link className="button" href="/dashboard/choose-plan">
                  Set up a plan
                </Link>
              </p>
            ) : !selfServe ? (
              <p className="hint">
                You are invoiced by hand, so we make plan changes for you —{" "}
                <Link href="/dashboard/requests">send us a request</Link> or reply to any of our emails.
              </p>
            ) : null}
          </>
        )}
      </section>

      {selfServe && addable.length > 0 && (
        <section className="card" aria-labelledby="plan-addons-more">
          <div className="card-head">
            <h2 id="plan-addons-more">Add a Growth tool</h2>
          </div>
          <p className="muted">Add one tool on its own, without changing your plan.</p>
          <ul className="plan-addons">
            {addable.map(({ feature }) => (
              <li key={feature.key}>
                <span>
                  <strong>{feature.name}</strong> · {dollars(feature.addOnCents)}/month
                  <br />
                  <span className="muted">{feature.summary}</span>
                </span>
                <PlanActionButton
                  action={addAddOnAction}
                  fields={{ feature: feature.key }}
                  label="Add"
                  pendingLabel="Adding…"
                  confirm={`Add ${feature.name} for ${dollars(feature.addOnCents)} a month? It starts now and is added to your next payment.`}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {selfServe && !state.cancelsOn && (
        <section className="card" aria-labelledby="plan-cancel">
          <div className="card-head">
            <h2 id="plan-cancel">Cancel</h2>
          </div>
          <p>
            Your plan stays active until the end of the period you have paid for, then stops. Your website
            stays online either way.
          </p>
          <PlanActionButton
            action={cancellationAction}
            fields={{ cancel: "1" }}
            label="Cancel my plan"
            pendingLabel="Cancelling…"
            variant="secondary"
            confirm="Cancel your plan? It stays active until the end of the period you have paid for. You can undo this any time before then."
          />
        </section>
      )}
    </main>
  );
}
