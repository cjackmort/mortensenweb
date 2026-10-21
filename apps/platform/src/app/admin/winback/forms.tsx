"use client";

import { useActionState } from "react";
import { haltAllAction, haltCampaignAction, type HaltActionResult } from "./actions";

export function HaltCampaignForm({ publicId, label }: { publicId: string; label: string }) {
  const [state, formAction, pending] = useActionState<HaltActionResult | null, FormData>(haltCampaignAction, null);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(`Stop "${label}"? Nobody else will get it, and the client sees why.`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="campaign" value={publicId} />
      <label className="sr-only" htmlFor={`reason-${publicId}`}>
        Reason, shown to the client
      </label>
      <input id={`reason-${publicId}`} type="text" name="reason" placeholder="Reason, shown to the client" maxLength={300} />
      <button type="submit" className="secondary small" disabled={pending}>
        {pending ? "Stopping…" : "Stop"}
      </button>
      {state && <p className={state.ok ? "notice notice-success" : "error"}>{state.message}</p>}
    </form>
  );
}

export function HaltAllForm() {
  const [state, formAction, pending] = useActionState<HaltActionResult | null, FormData>(haltAllAction, null);
  return (
    <form action={formAction} className="winback-form">
      <label htmlFor="halt-all-reason">Reason, shown to every client affected</label>
      <input id="halt-all-reason" type="text" name="reason" maxLength={300} placeholder="e.g. Sending is paused while we check a problem" />
      <label htmlFor="halt-all-confirm">Type STOP to confirm</label>
      <input id="halt-all-confirm" type="text" name="confirm" autoComplete="off" />
      <div className="winback-buttons">
        <button type="submit" disabled={pending}>
          {pending ? "Stopping…" : "Stop all win-back sending"}
        </button>
      </div>
      {state && <p className={state.ok ? "notice notice-success" : "error"}>{state.message}</p>}
    </form>
  );
}
