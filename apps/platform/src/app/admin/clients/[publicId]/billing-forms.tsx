"use client";

import { useActionState } from "react";
import {
  confirmReceivedAction,
  raiseRequestAction,
  type BillingResult,
} from "./billing-actions";

/**
 * Operator billing forms.
 *
 * Amounts are entered in dollars because that is what the operator is looking
 * at — a Venmo screen or a bank line. Conversion to integer cents happens
 * server-side in one place, so no float ever reaches the database.
 */

function Feedback({ state }: { state: BillingResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <p className="notice notice-success">{state.message}</p>
  ) : (
    <p className="error">{state.message}</p>
  );
}

export function RaiseRequestForm({
  clientPublicId,
  suggestedAmount,
}: {
  clientPublicId: string;
  suggestedAmount: string;
}) {
  const [state, formAction, pending] = useActionState<BillingResult | null, FormData>(
    raiseRequestAction,
    null,
  );

  // Default to the end of the current month — the usual billing rhythm.
  const due = new Date();
  due.setMonth(due.getMonth() + 1, 1);
  due.setDate(0);
  const defaultDue = due.toISOString().slice(0, 10);

  return (
    <form action={formAction}>
      <Feedback state={state} />

      <input type="hidden" name="clientPublicId" value={clientPublicId} />

      <label htmlFor="amount">Amount (USD)</label>
      <input
        id="amount"
        name="amount"
        type="text"
        inputMode="decimal"
        defaultValue={suggestedAmount}
        placeholder="99.00"
        required
      />

      <label htmlFor="dueOn">Due date</label>
      <input id="dueOn" name="dueOn" type="date" defaultValue={defaultDue} required />

      <label htmlFor="note">Note (optional, shown to the client)</label>
      <input
        id="note"
        name="note"
        type="text"
        placeholder="Website management — March"
      />

      <button type="submit" disabled={pending}>
        {pending ? "Raising…" : "Raise payment request"}
      </button>
    </form>
  );
}

export function ConfirmReceivedForm({
  clientPublicId,
  requestPublicId,
  amount,
  reference,
}: {
  clientPublicId: string;
  requestPublicId: string;
  amount: string;
  reference: string;
}) {
  const [state, formAction, pending] = useActionState<BillingResult | null, FormData>(
    confirmReceivedAction,
    null,
  );

  return (
    <form action={formAction}>
      <Feedback state={state} />

      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input type="hidden" name="requestPublicId" value={requestPublicId} />

      <div className="actions" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 8rem" }}>
          <label htmlFor={`method-${requestPublicId}`}>Received by</label>
          <select
            id={`method-${requestPublicId}`}
            name="method"
            defaultValue="venmo"
            style={{ marginBottom: 0 }}
          >
            <option value="venmo">Venmo</option>
            <option value="cash">Cash</option>
            <option value="check">Check</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="card">Card</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div style={{ flex: "1 1 8rem" }}>
          <label htmlFor={`on-${requestPublicId}`}>On</label>
          <input
            id={`on-${requestPublicId}`}
            name="receivedOn"
            type="date"
            defaultValue={new Date().toISOString().slice(0, 10)}
            style={{ marginBottom: 0 }}
          />
        </div>
        <button type="submit" disabled={pending} style={{ flex: "0 0 auto" }}>
          {pending ? "Recording…" : `Confirm ${amount} received`}
        </button>
      </div>

      <p className="field-hint" style={{ margin: "0.75rem 0 0" }}>
        Match against <strong>{reference}</strong> in the Venmo note. This writes
        a permanent ledger entry — corrections are made by recording an
        adjustment, never by editing history.
      </p>
    </form>
  );
}
