"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import { FREE_PORTAL } from "@mortensenweb/plans";
import {
  addOnOptions,
  buildWelcomeBasket,
  cheaperPlanFor,
  formatMoney,
  type AddOnOption,
  type Basket,
  type OfferedPlan,
  type SiteDue,
} from "@/lib/onboarding/checkout";
import { startWelcomeCheckoutAction, type WelcomeCheckoutResult } from "./actions";

/**
 * The choosing half of the welcome page: a plan, add-ons, and the total.
 *
 * The total is worked out here by the same function the server uses to build
 * the Stripe checkout (`buildWelcomeBasket`), so what the client sees is what
 * they are sent to pay. The form posts keys only — the server re-checks the
 * choice and decides every amount.
 *
 * The site section arrives from the server as `siteSection` and sits outside
 * the form: an open invoice brings its own pay buttons, and forms cannot nest.
 */

export interface WelcomePlan extends OfferedPlan {
  description: string;
  features: string[];
  /** The plan an operator assigned this client. */
  recommended: boolean;
  featured: boolean;
}

const PER_MONTH = "/mo";

export function WelcomeCheckout({
  siteSection,
  siteDue,
  plans,
  currentPlanName,
  initialPlanKey,
  initialAddOns,
  stripeReady,
  billingDayLabel,
  promo,
}: {
  siteSection: ReactNode;
  siteDue: SiteDue;
  /** Null when no plan can be chosen here: on the house, or already billed by a processor. */
  plans: WelcomePlan[] | null;
  /** The plan they already pay for, when `plans` is null for that reason. */
  currentPlanName: string | null;
  initialPlanKey: string | null;
  initialAddOns: string[];
  stripeReady: boolean;
  /** "1st" when an operator set a payment day. */
  billingDayLabel: string | null;
  promo: { code: string; terms: string | null } | null;
}) {
  const [planKey, setPlanKey] = useState<string | null>(initialPlanKey);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(initialAddOns));
  const [result, submit, pending] = useActionState<WelcomeCheckoutResult | null, FormData>(
    startWelcomeCheckoutAction,
    null,
  );

  // Stripe hands back a URL rather than the server redirecting, so a refusal
  // leaves the client here with the reason. Navigating is a side effect.
  useEffect(() => {
    if (result?.ok) window.location.href = result.url;
  }, [result]);

  // Only what exists: a feature still being built is not listed for sale.
  const options = addOnOptions(planKey).filter((o) => o.state.kind !== "coming_soon");
  // A ticked add-on the plan now includes, or that needs a plan when none is
  // chosen, stays remembered but is not charged.
  const chosenAddOns = options
    .filter((o) => o.state.kind === "available" && ticked.has(o.feature.key))
    .map((o) => o.feature.key);
  const offered = plans ?? [];
  const built = buildWelcomeBasket({ siteDue, plans: offered, planKey, addOns: chosenAddOns });
  const basket = built.ok ? built.basket : null;
  const nudge = cheaperPlanFor(planKey, chosenAddOns, offered);
  const chosenPlan = offered.find((p) => p.key === planKey) ?? null;
  const redirecting = pending || result?.ok === true;
  const canPay = stripeReady && basket !== null && !redirecting;
  // Paying for the build is what puts the site live (decision D1), so the
  // button says so, with the whole of what is due today.
  const payLabel = basket?.includesBuild
    ? `Put it live — ${formatMoney(basket.dueTodayCents)}`
    : basket
      ? "Continue to secure payment"
      : "Nothing to pay yet";

  function toggle(key: string) {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="welcome-layout">
      <div className="welcome-choices">
        {siteSection}

        {plans ? (
          <>
            <section className="panel" aria-labelledby="welcome-plan">
              <div className="panel-head">
                <h2 id="welcome-plan">Add a care plan</h2>
                <span className="panel-sub">Optional</span>
              </div>
              <div className="panel-body">
                <p className="welcome-lead">
                  A plan covers changes to your site each month. You can add, change or cancel one later.
                </p>
                <div className="welcome-options" role="radiogroup" aria-labelledby="welcome-plan">
                  <PlanOption
                    checked={planKey === null}
                    onChoose={() => setPlanKey(null)}
                    name="No plan for now"
                    price="$0"
                    description={FREE_PORTAL.description}
                    features={FREE_PORTAL.features}
                  />
                  {plans.map((plan) => (
                    <PlanOption
                      key={plan.key}
                      checked={planKey === plan.key}
                      onChoose={() => setPlanKey(plan.key)}
                      name={plan.name}
                      price={`${formatMoney(plan.monthlyCents)}${PER_MONTH}`}
                      description={plan.description}
                      features={plan.features}
                      tag={plan.recommended ? "Suggested for you" : plan.featured ? "Most popular" : null}
                    />
                  ))}
                </div>
              </div>
            </section>

            <section className="panel" aria-labelledby="welcome-addons">
              <div className="panel-head">
                <h2 id="welcome-addons">Growth add-ons</h2>
                <span className="panel-sub">Optional · monthly, on top of a plan</span>
              </div>
              <div className="panel-body">
                {planKey === null && (
                  <p className="welcome-lead">Choose a plan above to add any of these. The free ones come with every site.</p>
                )}
                {nudge && (
                  <div className="notice notice-info welcome-nudge">
                    <p>
                      {nudge.planName} includes {chosenAddOns.length === 1 ? "that add-on" : "these add-ons"}, for{" "}
                      {formatMoney(nudge.savesCents)} a month less than adding{" "}
                      {chosenAddOns.length === 1 ? "it" : "them"} to {chosenPlan?.name ?? "your plan"}.
                    </p>
                    <button type="button" className="secondary small" onClick={() => setPlanKey(nudge.planKey)}>
                      Switch to {nudge.planName}
                    </button>
                  </div>
                )}
                <ul className="welcome-addons">
                  {options.map((option) => (
                    <AddOnRow
                      key={option.feature.key}
                      option={option}
                      checked={chosenAddOns.includes(option.feature.key)}
                      onToggle={() => toggle(option.feature.key)}
                    />
                  ))}
                </ul>
              </div>
            </section>
          </>
        ) : (
          currentPlanName && (
            <p className="notice">
              You&rsquo;re on {currentPlanName}. Change it, or add Growth tools, on the{" "}
              <Link href="/dashboard/plan">Plan</Link> tab.
            </p>
          )
        )}
      </div>

      <aside className="panel welcome-summary" id="welcome-summary" aria-labelledby="welcome-total">
        <div className="panel-head">
          <h2 id="welcome-total">Your total</h2>
        </div>
        <div className="panel-body">
          <Summary basket={basket} siteDue={siteDue} billingDayLabel={billingDayLabel} promo={promo} />

          {!built.ok && <p className="error">{built.message}</p>}
          {result && !result.ok && (
            <p className="notice notice-danger" role="alert">
              {result.message}
            </p>
          )}
          {!stripeReady && (
            <p className="notice welcome-unconfigured">
              Card payments aren&rsquo;t switched on yet, so this can&rsquo;t be paid online today. We&rsquo;ll
              send you a payment link. Carry on setting up meanwhile.
            </p>
          )}

          <form action={submit} id="welcome-checkout" className="welcome-pay">
            <input type="hidden" name="planKey" value={planKey ?? "none"} />
            {chosenAddOns.map((key) => (
              <input key={key} type="hidden" name="addOns" value={key} />
            ))}
            <button type="submit" disabled={!canPay}>
              {redirecting ? "Opening Stripe…" : payLabel}
            </button>
          </form>
          <p className="welcome-fine">You&rsquo;ll enter your card on Stripe&rsquo;s secure page, not here.</p>
          <p className="welcome-skip">
            <Link href="/dashboard/get-started">I&rsquo;ll do this later</Link>
          </p>
        </div>
      </aside>

      {basket && (
        <div className="welcome-bar" aria-hidden="true">
          <span>
            <small>Due today</small>
            <strong>{formatMoney(basket.dueTodayCents)}</strong>
          </span>
          <button type="submit" form="welcome-checkout" disabled={!canPay} tabIndex={-1}>
            {redirecting ? "Opening Stripe…" : basket.includesBuild ? "Put it live" : "Continue"}
          </button>
        </div>
      )}
    </div>
  );
}

function PlanOption({
  checked,
  onChoose,
  name,
  price,
  description,
  features,
  tag = null,
}: {
  checked: boolean;
  onChoose: () => void;
  name: string;
  price: string;
  description: string;
  features: string[];
  tag?: string | null;
}) {
  return (
    <label className={`welcome-option${checked ? " is-chosen" : ""}`}>
      <input type="radio" name="welcome-plan-choice" checked={checked} onChange={onChoose} />
      <span className="welcome-option-body">
        <span className="welcome-option-head">
          <strong>{name}</strong>
          {tag && <span className="plan-tag">{tag}</span>}
          <span className="welcome-option-price">{price}</span>
        </span>
        <span className="welcome-option-desc">{description}</span>
        <span className="welcome-option-features">{features.join(" · ")}</span>
      </span>
    </label>
  );
}

function AddOnRow({ option, checked, onToggle }: { option: AddOnOption; checked: boolean; onToggle: () => void }) {
  const { feature, state } = option;
  const id = `addon-${feature.key}`;
  const sellable = state.kind === "available" || state.kind === "needs_plan";

  return (
    <li className={`welcome-addon welcome-addon--${state.kind}${checked ? " is-chosen" : ""}`}>
      {sellable ? (
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={state.kind === "needs_plan"}
          onChange={onToggle}
        />
      ) : (
        <span className="welcome-addon-mark" aria-hidden="true">
          ✓
        </span>
      )}
      <label htmlFor={sellable ? id : undefined} className="welcome-addon-body">
        <strong>{feature.name}</strong>
        <span>{feature.summary}</span>
      </label>
      <span className="welcome-addon-price">
        {state.kind === "free" && <span className="pill pill-success">Free</span>}
        {state.kind === "included" && <span className="pill pill-accent">In {state.planName}</span>}
        {sellable && `+${formatMoney(state.monthlyCents)}${PER_MONTH}`}
      </span>
    </li>
  );
}

function Summary({
  basket,
  siteDue,
  billingDayLabel,
  promo,
}: {
  basket: Basket | null;
  siteDue: SiteDue;
  billingDayLabel: string | null;
  promo: { code: string; terms: string | null } | null;
}) {
  if (!basket) {
    return (
      <p className="welcome-empty">
        {siteDue.kind === "invoice"
          ? "Your invoice is paid on its own, above. Choose a plan here if you'd like one."
          : "Your website is paid for. Choose a plan or add-ons if you'd like them."}
      </p>
    );
  }

  const prorated = basket.mode === "subscription" && billingDayLabel !== null;
  return (
    <>
      <ul className="welcome-lines">
        {[...basket.lines].sort((a, b) => Number(b.kind === "build") - Number(a.kind === "build")).map((line) => (
          <li key={`${line.kind}-${line.key}`}>
            <span>{line.name}</span>
            <span>
              {formatMoney(line.amountCents)}
              <small>{line.recurring ? PER_MONTH : " once"}</small>
            </span>
          </li>
        ))}
      </ul>
      <p className="welcome-due">
        <span>Due today</span>
        <strong>{formatMoney(basket.dueTodayCents)}</strong>
      </p>
      {basket.monthlyCents > 0 && (
        <p className="welcome-then">
          Then {formatMoney(basket.monthlyCents)} a month
          {billingDayLabel ? `, on the ${billingDayLabel}` : ""}. Cancel any time.
        </p>
      )}
      {prorated && (
        <p className="welcome-fine">
          Your first month runs to the {billingDayLabel}, so Stripe may charge less than this today.
        </p>
      )}
      {promo && (
        <p className="welcome-fine">
          {basket.mode === "subscription"
            ? `Your code ${promo.code}${promo.terms ? ` (${promo.terms})` : ""} is applied on the payment page.`
            : `Your code ${promo.code} applies when you choose a plan. A website code can be entered on the payment page.`}
        </p>
      )}
    </>
  );
}
