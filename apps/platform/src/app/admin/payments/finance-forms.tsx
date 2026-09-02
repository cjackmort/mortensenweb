"use client";

import { useActionState } from "react";
import {
  addExpenseAction,
  deleteExpenseAction,
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

export function AddExpenseForm() {
  const [state, formAction, pending] = useActionState<LedgerResult | null, FormData>(
    addExpenseAction,
    null,
  );

  return (
    <form action={formAction} className="form">
      <Feedback state={state} />

      <div className="actions" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 12rem" }}>
          <label htmlFor="description">What was it</label>
          <input
            id="description"
            name="description"
            type="text"
            placeholder="Netlify Pro plan"
            required
            style={{ marginBottom: 0 }}
          />
        </div>

        <div style={{ flex: "1 1 7rem" }}>
          <label htmlFor="amount">Amount (USD)</label>
          <input
            id="amount"
            name="amount"
            type="text"
            inputMode="decimal"
            placeholder="19.00"
            required
            style={{ marginBottom: 0 }}
          />
        </div>

        <div style={{ flex: "1 1 9rem" }}>
          <label htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue="software" style={{ marginBottom: 0 }}>
            <option value="software">Software</option>
            <option value="hosting">Hosting</option>
            <option value="contractor">Contractor</option>
            <option value="marketing">Marketing</option>
            <option value="equipment">Equipment</option>
            <option value="fees">Fees</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div style={{ flex: "1 1 8rem" }}>
          <label htmlFor="occurredOn">Date</label>
          <input
            id="occurredOn"
            name="occurredOn"
            type="date"
            defaultValue={new Date().toISOString().slice(0, 10)}
            required
            style={{ marginBottom: 0 }}
          />
        </div>

        <button type="submit" disabled={pending} style={{ flex: "0 0 auto" }}>
          {pending ? "Adding…" : "Add expense"}
        </button>
      </div>

      <label htmlFor="isRecurring" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
        <input id="isRecurring" name="isRecurring" type="checkbox" style={{ width: "auto" }} />
        Recurs monthly (tag only — this doesn&rsquo;t re-add itself next month)
      </label>
    </form>
  );
}

export function DeleteExpenseButton({ publicId }: { publicId: string }) {
  const [, formAction, pending] = useActionState<LedgerResult | null, FormData>(
    deleteExpenseAction,
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="publicId" value={publicId} />
      <button
        type="submit"
        className="secondary"
        disabled={pending}
        style={{ width: "auto", minHeight: "auto", padding: "0.15rem 0.5rem", fontSize: "0.78rem" }}
      >
        Remove
      </button>
    </form>
  );
}
