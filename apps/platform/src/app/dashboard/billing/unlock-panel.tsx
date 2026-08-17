"use client";

import { useActionState, useEffect } from "react";
import {
  startCheckoutAction,
  type CheckoutResult,
} from "./checkout-actions";

/**
 * "Unlock your analytics."
 *
 * The client's entry point into paying. Shown when their features are still
 * locked, which is the state every client starts in.
 *
 * The copy leads with what they get rather than what they owe. They already
 * know there is a price; what they are deciding is whether it is worth it
 * today, and a panel headed with an amount reads like a demand rather than an
 * offer.
 *
 * Redirect happens client-side from the returned URL, so a Square failure
 * leaves them on this page with an explanation instead of on a broken one.
 */

export interface UnlockPanelProps {
  amountLabel: string;
  planName: string | null;
  /** Whether the plan can actually enrol in recurring billing. */
  recurringAvailable: boolean;
  /** Analytics is not on every plan; the pitch changes when it is absent. */
  includesAnalytics: boolean;
}

function Redirector({ url }: { url: string }) {
  useEffect(() => {
    // Replace rather than assign: the back button should return to billing,
    // not bounce them straight back into checkout.
    window.location.replace(url);
  }, [url]);

  return (
    <div className="notice notice-success" style={{ margin: 0 }}>
      <strong>Taking you to Square…</strong>
      <p style={{ margin: "0.35rem 0 0" }}>
        If nothing happens,{" "}
        <a href={url} rel="noopener noreferrer">
          open the payment page
        </a>
        .
      </p>
    </div>
  );
}

export function UnlockPanel({
  amountLabel,
  planName,
  recurringAvailable,
  includesAnalytics,
}: UnlockPanelProps) {
  const [state, formAction, pending] = useActionState<
    CheckoutResult | null,
    FormData
  >(startCheckoutAction, null);

  if (state?.ok) return <Redirector url={state.url} />;

  return (
    <section className="card">
      <div className="card-head">
        <h2>{includesAnalytics ? "Unlock your analytics" : "Start your plan"}</h2>
        {planName && <span className="muted">{planName}</span>}
      </div>

      <p style={{ marginTop: 0 }}>
        {includesAnalytics ? (
          <>
            See how many people visit your site, what they look at, and where
            they came from &mdash; and start sending us changes whenever you
            need them.
          </>
        ) : (
          <>
            Start your plan to send us changes whenever you need them.
          </>
        )}
      </p>

      <p className="stat-value" style={{ marginBottom: "0.25rem" }}>
        {amountLabel}
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        per month
      </p>

      {state && !state.ok && <p className="error">{state.message}</p>}

      <div className="actions" style={{ marginTop: "1.25rem" }}>
        {recurringAvailable && (
          <form action={formAction}>
            <input type="hidden" name="recurring" value="true" />
            <button type="submit" disabled={pending}>
              {pending ? "Starting…" : "Set up monthly payments"}
            </button>
          </form>
        )}

        <form action={formAction}>
          <input type="hidden" name="recurring" value="false" />
          <button
            type="submit"
            className={recurringAvailable ? "secondary" : undefined}
            disabled={pending}
          >
            {pending ? "Starting…" : "Pay this month only"}
          </button>
        </form>
      </div>

      {/* Both options are offered, and the one-off is not buried. Automatic
          payment is better for us and for most clients, but a small business
          owner who wants to keep a hand on the tap is making a reasonable
          choice, and hiding it would be a dark pattern. */}
      <p className="field-hint">
        {recurringAvailable
          ? "Monthly payments can be cancelled any time from your Square receipt, or just ask us."
          : "You'll be able to switch to automatic monthly payments soon."}
      </p>

      <p className="field-hint">
        Payment is handled by Square. We never see or store your card details.
      </p>
    </section>
  );
}
