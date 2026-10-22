"use client";

import { useActionState } from "react";
import { reopenAdAction, startAdCheckoutAction, type PayState } from "../actions";

/** Off to Stripe, or a plain sentence about why not. */
export function PayButton({ campaign, label, disabled }: { campaign: string; label: string; disabled?: boolean }) {
  const [state, formAction, pending] = useActionState<PayState, FormData>(startAdCheckoutAction, null);
  return (
    <form action={formAction} className="ad-pay">
      <input type="hidden" name="campaign" value={campaign} />
      <button type="submit" disabled={disabled || pending}>
        {pending ? "Opening checkout…" : label}
      </button>
      {state && (
        <p className="error" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}

/** Back to editing. Cancels an open checkout first, so an old tab can't pay. */
export function ReopenButton({ campaign, disabled }: { campaign: string; disabled?: boolean }) {
  const [state, formAction, pending] = useActionState<PayState, FormData>(reopenAdAction, null);
  return (
    <form action={formAction} className="ad-pay">
      <input type="hidden" name="campaign" value={campaign} />
      <button type="submit" className="secondary" disabled={disabled || pending}>
        {pending ? "Reopening…" : "Change something"}
      </button>
      {state && (
        <p className="error" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
