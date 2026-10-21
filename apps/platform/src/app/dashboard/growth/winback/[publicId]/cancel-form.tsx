"use client";

import { useActionState } from "react";
import { cancelCampaignAction, type ActionResult } from "../actions";

export function CancelCampaignForm({
  publicId,
  sending,
  readOnly,
}: {
  publicId: string;
  sending: boolean;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(cancelCampaignAction, null);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const question = sending
          ? "Stop sending? Customers who already got it keep it; nobody else will."
          : "Cancel this email? Nobody will get it.";
        if (!window.confirm(question)) event.preventDefault();
      }}
    >
      <input type="hidden" name="campaign" value={publicId} />
      <button type="submit" className="secondary" disabled={pending || readOnly}>
        {sending ? "Stop sending" : "Cancel this email"}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
