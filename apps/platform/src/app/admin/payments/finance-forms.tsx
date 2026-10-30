"use client";

import { useActionState } from "react";
import { LEDGER_CATEGORY_LABEL } from "@/lib/finance/ledger-csv";
import {
  addExpenseAction,
  stopRecurringExpenseAction,
  type LedgerResult,
} from "./finance-actions";

function Feedback({ state }: { state: LedgerResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <p className="notice notice-success">{state.message}</p>
  ) : (
    <p className="error">{state.message}</p>
  );
}

/**
 * One expense. `today` comes from the server in the business timezone: the
 * browser's `toISOString()` is UTC, which after 6pm in Denver is tomorrow.
 */
export function AddExpenseForm({ today }: { today: string }) {
  const [state, formAction, pending] = useActionState<LedgerResult | null, FormData>(
    addExpenseAction,
    null,
  );

  return (
    <form action={formAction} className="pay-expense-form">
      <Feedback state={state} />

      <div className="pay-expense-fields">
        <div className="pay-expense-what">
          <label htmlFor="description">What was it</label>
          <input id="description" name="description" type="text" placeholder="Netlify Pro plan" required />
        </div>
        <div>
          <label htmlFor="amount">Amount (USD)</label>
          <input id="amount" name="amount" type="text" inputMode="decimal" placeholder="19.00" required />
        </div>
        <div>
          <label htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue="software">
            {Object.entries(LEDGER_CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="occurredOn">Date</label>
          <input id="occurredOn" name="occurredOn" type="date" defaultValue={today} required />
        </div>
      </div>

      <label htmlFor="isRecurring" className="checkbox">
        <input id="isRecurring" name="isRecurring" type="checkbox" style={{ width: "auto", minHeight: 0 }} />
        <span>Repeats monthly (added again on the same day each month until you stop it)</span>
      </label>

      <button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add expense"}
      </button>
    </form>
  );
}

export function StopRecurringButton({ publicId }: { publicId: string }) {
  const [, formAction, pending] = useActionState<LedgerResult | null, FormData>(
    stopRecurringExpenseAction,
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="publicId" value={publicId} />
      <button type="submit" className="linklike" disabled={pending}>
        Stop repeating
      </button>
    </form>
  );
}
