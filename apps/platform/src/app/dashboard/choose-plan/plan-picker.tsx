"use client";

import { useActionState, useEffect } from "react";
import type { PlanCard } from "@/db/repositories/client/plan-choice";
import {
  startStripeSubscriptionAction,
  type StripeCheckoutResult,
} from "../billing/stripe-actions";

/**
 * The plans side by side, each with what it includes.
 *
 * Choosing one posts its key and nothing else; the server resolves the price
 * and the payment day (see `stripe-checkout.ts`). Stripe's own page then takes
 * the card, so no card number ever touches this portal.
 */

function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** What one change costs inside the plan, which is where the bigger plans win. */
function perChange(plan: PlanCard): string | null {
  if (plan.includedChangesPerMonth === null) return "As many changes as you need";
  if (plan.includedChangesPerMonth <= 1) return null;
  return `Works out to ${dollars(Math.round(plan.monthlyCents / plan.includedChangesPerMonth))} a change`;
}

export function PlanPicker({ plans }: { plans: PlanCard[] }) {
  const [result, choose, pending] = useActionState<StripeCheckoutResult | null, FormData>(
    startStripeSubscriptionAction,
    null,
  );

  // Stripe hands back a URL rather than the server redirecting, so a refusal
  // leaves the client here with the reason. Navigating is a side effect, so it
  // happens in an effect rather than during render.
  useEffect(() => {
    if (result?.ok) window.location.href = result.url;
  }, [result]);

  return (
    <>
      {result && !result.ok && <p className="notice notice-danger">{result.message}</p>}

      <div className="plan-grid">
        {plans.map((plan) => {
          const tag = plan.recommended ? "Suggested for you" : plan.featured ? "Most popular" : null;
          const value = perChange(plan);
          return (
            <form
              key={plan.key}
              action={choose}
              className={`plan-card${plan.recommended || plan.featured ? " is-lifted" : ""}`}
            >
              <input type="hidden" name="planKey" value={plan.key} />
              <div className="plan-card-head">
                <h2>{plan.short}</h2>
                {tag && <span className="plan-tag">{tag}</span>}
              </div>
              <p className="plan-price">
                <strong>{dollars(plan.monthlyCents)}</strong>
                <span> a month</span>
              </p>
              {value && <p className="plan-value">{value}</p>}
              <p className="plan-description">{plan.description}</p>
              <ul className="plan-features">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              {plan.bestFor && <p className="plan-best-for">{plan.bestFor}</p>}
              <button type="submit" disabled={pending} className={tag ? undefined : "secondary"}>
                {pending ? "Opening Stripe…" : `Choose ${plan.short}`}
              </button>
            </form>
          );
        })}
      </div>
    </>
  );
}
