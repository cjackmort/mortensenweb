"use client";

import { useActionState } from "react";
import { setCompPlanAction, type CompResult } from "./comp-actions";

/**
 * Granting a plan without payment.
 *
 * For the cases the payments table cannot express: family, a friend of the
 * business, someone owed an apology, a client who paid cash before any of this
 * existed, a beta tester. Without it the only route to a working account is a
 * confirmed payment, which makes those clients unserviceable rather than free.
 *
 * A plan rather than a switch, because "free" is not one thing. Three changes a
 * month and unlimited are different offers, and reusing the plan list means a
 * comp cannot describe a package that does not exist.
 */

export interface CompPlanOption {
  key: string;
  name: string;
  includedChangesPerMonth: number | null;
}

export function CompPanel({
  clientPublicId,
  plans,
  currentCompPlanId,
  currentNote,
  paidPlanName,
}: {
  clientPublicId: string;
  plans: CompPlanOption[];
  currentCompPlanId: string | null;
  currentNote: string | null;
  paidPlanName: string | null;
}) {
  const [state, action, pending] = useActionState<CompResult | null, FormData>(
    setCompPlanAction,
    null,
  );

  const active = plans.find((p) => p.key === currentCompPlanId) ?? null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Plan override</h2>
        {active && <span className="muted">Comped</span>}
      </div>

      {active ? (
        <div className="notice notice-success" style={{ marginTop: 0 }}>
          <strong>On {active.name}, free of charge.</strong>{" "}
          {active.includedChangesPerMonth === null
            ? "Unlimited changes."
            : `${active.includedChangesPerMonth} changes a month.`}{" "}
          Analytics and change requests are unlocked without payment.
          {currentNote && (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.92rem" }}>
              {currentNote}
            </p>
          )}
        </div>
      ) : (
        <p style={{ marginTop: 0 }}>
          This client gets what they pay for
          {paidPlanName ? ` — currently ${paidPlanName}` : ", and has no active plan"}.
          Set an override to give them a plan regardless of payment.
        </p>
      )}

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"}>
          {state.message}
        </p>
      )}

      <form action={action} style={{ marginTop: "1rem" }}>
        <input type="hidden" name="clientPublicId" value={clientPublicId} />

        <label htmlFor="compPlanId">Give them</label>
        <select
          id="compPlanId"
          name="compPlanId"
          defaultValue={currentCompPlanId ?? ""}
        >
          <option value="">Default — whatever they have paid for</option>
          {plans.map((plan) => (
            <option key={plan.key} value={plan.key}>
              {plan.name}
              {plan.includedChangesPerMonth === null
                ? " — unlimited changes"
                : ` — ${plan.includedChangesPerMonth} changes/month`}
            </option>
          ))}
        </select>

        <label htmlFor="compNote">Why</label>
        <input
          id="compNote"
          name="compNote"
          defaultValue={currentNote ?? ""}
          placeholder="Family — no charge"
        />
        {/* Asked for at the time because it is asked about later, usually
            months on and usually by someone reconciling why one client shows
            no revenue. */}
        <p className="field-hint">
          Recorded against the client, so &ldquo;why is this one free?&rdquo;
          has an answer later.
        </p>

        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : active ? "Update override" : "Apply override"}
        </button>
      </form>

      <p className="field-hint">
        A comp does not change what the plan costs or what the ledger says —
        only what this client receives. Choosing <em>Default</em> withdraws it,
        and their access goes back to following payment.
      </p>
    </section>
  );
}
