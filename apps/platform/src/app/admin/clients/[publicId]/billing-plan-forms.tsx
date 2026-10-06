"use client";

import { useActionState, useState } from "react";
import {
  assignPlanAction,
  createPaymentLinkAction,
  type PaymentLinkResult,
  type PlanFormResult,
} from "./billing-plan-actions";

/**
 * The plan a client is on and the day they pay.
 *
 * Before they pay by card, this is the plan they are offered at checkout and
 * the day Stripe will charge. Once Stripe is charging them, saving changes the
 * live subscription — which is said under the button, because it moves money.
 */

export interface PlanOption {
  key: string;
  name: string;
  monthlyCents: number;
  includedChangesPerMonth: number | null;
}

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function changes(count: number | null): string {
  if (count === null) return "unlimited changes";
  return count === 1 ? "1 change" : `${count} changes`;
}

export function PlanForm({
  clientPublicId,
  plans,
  currentPlanKey,
  currentDay,
  onStripe,
}: {
  clientPublicId: string;
  plans: PlanOption[];
  currentPlanKey: string | null;
  /** Their day, or a suggestion when none is saved yet. */
  currentDay: number;
  onStripe: boolean;
}) {
  const [state, action, pending] = useActionState<PlanFormResult | null, FormData>(
    assignPlanAction,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="clientPublicId" value={clientPublicId} />

      <div className="profile-grid" style={{ marginBottom: "0.75rem" }}>
        <div>
          <label htmlFor="planKey">Plan</label>
          <select id="planKey" name="planKey" defaultValue={currentPlanKey ?? ""} required>
            <option value="" disabled>
              Choose a plan
            </option>
            {plans.map((plan) => (
              <option key={plan.key} value={plan.key}>
                {plan.name}: {money(plan.monthlyCents)} a month, {changes(plan.includedChangesPerMonth)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="billingDay">Pays on</label>
          <select id="billingDay" name="billingDay" defaultValue={String(currentDay)}>
            {DAYS.map((day) => (
              <option key={day} value={day}>
                Day {day} of each month
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="field-hint">
        {onStripe
          ? "They already pay by card. Saving changes their Stripe subscription: a new plan starts with their next payment, and a new day takes effect after the period they've paid for. Neither charges them today."
          : "This is the plan they're offered when they set up automatic payments, and the day Stripe charges them each month. They can still pick a different plan themselves."}
      </p>

      {state && <p className={state.ok ? "notice notice-success" : "error"}>{state.message}</p>}

      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save plan"}
      </button>
    </form>
  );
}

export function PaymentLinkForm({ clientPublicId }: { clientPublicId: string }) {
  const [state, action, pending] = useActionState<PaymentLinkResult | null, FormData>(
    createPaymentLinkAction,
    null,
  );
  const [copied, setCopied] = useState(false);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <form action={action}>
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <p className="field-hint" style={{ marginTop: 0 }}>
        A Stripe checkout page for the saved plan. Send it to them, or open it yourself to try a
        payment. Each link works for 24 hours.
      </p>

      {state && !state.ok && <p className="error">{state.message}</p>}
      {state?.ok && (
        <div className="payment-link">
          <input readOnly value={state.url} aria-label="Payment link" onFocus={(e) => e.currentTarget.select()} />
          <div className="actions">
            <button type="button" className="secondary small" onClick={() => copy(state.url)}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className="button small" href={state.url} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </div>
        </div>
      )}

      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Making link…" : "Make a payment link"}
      </button>
    </form>
  );
}
