"use client";

import { useActionState } from "react";
import {
  beginExtraChangeAction,
  type ExtraChangeStartResult,
} from "./extra-change-actions";
import { PayPanel } from "./pay-panel";

/**
 * "Buy one more change this month."
 *
 * A separate card from the main "amount due" one on purpose — the two are
 * unrelated invoices (a subscription due date has nothing to do with wanting
 * extra capacity), and `getBillingOverview` only ever surfaces one "current"
 * request at a time. This panel manages its own, independently.
 *
 * Two-step like `UnlockPanel`: nothing is created until the button is
 * pressed, so a client who never wants this never gets an invoice row for
 * it. Pressing it again later (a new page load resets this component's
 * local state) reuses the same open request rather than minting a second
 * one — `getOrCreateExtraChangeRequest` handles that, not this component.
 */

export function ExtraChangePanel({ amountLabel }: { amountLabel: string }) {
  const [state, formAction, pending] = useActionState<
    ExtraChangeStartResult | null,
    FormData
  >(beginExtraChangeAction, null);

  if (state?.ok) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Extra change</h2>
          <span className="muted">Ref {state.reference}</span>
        </div>

        <p className="stat-value" style={{ marginBottom: "0.25rem" }}>
          {state.amount}
        </p>
        <p className="muted" style={{ marginTop: 0 }}>
          For one additional change this month.
        </p>

        <div style={{ marginTop: "1.25rem" }}>
          <PayPanel
            requestPublicId={state.requestPublicId}
            venmoUrl={state.venmoUrl}
            cardAvailable={state.cardAvailable}
            reference={state.reference}
            amount={state.amount}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Need one more change this month?</h2>
      </div>

      <p style={{ marginTop: 0 }}>
        Buy a single additional change for {amountLabel} whenever your
        monthly allowance runs out — no need to wait for next month.
      </p>

      {state && !state.ok && <p className="error">{state.message}</p>}

      <form action={formAction}>
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Starting…" : `Buy one more change — ${amountLabel}`}
        </button>
      </form>
    </section>
  );
}
