"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ReviewResult } from "@/db/repositories/client/reviews";
import { addSuppressionAction, removeSuppressionAction } from "./actions";

/** "Don't ask this person": an email or a number the business adds by hand. */
export function AddSuppressionForm({ readOnly }: { readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ReviewResult | null, FormData>(addSuppressionAction, null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction} className="review-suppress">
      <label htmlFor="review-suppress-address">Don&rsquo;t ask this person</label>
      <input id="review-suppress-address" name="address" placeholder="Email address or phone number" required disabled={readOnly || pending} />
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <button type="submit" className="secondary" disabled={readOnly || pending}>
        {pending ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

/** Only for someone the business added; a customer's own opt-out has no button. */
export function RemoveSuppressionButton({
  channel,
  address,
  readOnly,
}: {
  channel: string;
  address: string;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ReviewResult | null, FormData>(removeSuppressionAction, null);
  return (
    <form action={formAction} className="review-unsuppress">
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="address" value={address} />
      <button type="submit" className="secondary" disabled={readOnly || pending}>
        {pending ? "Removing…" : "Remove"}
      </button>
      {state && !state.ok && <span className="error">{state.message}</span>}
    </form>
  );
}
