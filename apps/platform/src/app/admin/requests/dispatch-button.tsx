"use client";

import { useActionState } from "react";
import { startAutomatedWork, type DispatchResult } from "./actions";

/**
 * Sending a request to the agent.
 *
 * The action has existed since Stage 3 and nothing ever rendered a control for
 * it, so the only way to dispatch anything was to have `AGENT_AUTO_DISPATCH`
 * switched on — which meant the deliberate, watch-it-happen path the flag is
 * *off* by default for did not exist.
 *
 * Only shown for a request that has not been sent yet. A dispatched one already
 * has an agent job against it, and a second dispatch would open a second issue
 * for the same change.
 */
export function DispatchButton({
  requestPublicId,
  status,
}: {
  requestPublicId: string;
  status: string;
}) {
  const [state, action, pending] = useActionState<
    DispatchResult | null,
    FormData
  >(startAutomatedWork, null);

  // Mirrors DISPATCHABLE in the repository layer. Kept narrow on purpose: the
  // real gate is server-side, and this only decides whether to offer a button
  // that would be refused.
  const dispatchable = ["submitted", "triaged", "approved"].includes(status);

  if (state?.ok) {
    return (
      <span className="pill pill-success">Sent to the agent</span>
    );
  }

  if (!dispatchable) {
    return <span className="muted">&mdash;</span>;
  }

  return (
    <>
      <form action={action}>
        <input type="hidden" name="requestPublicId" value={requestPublicId} />
        <button type="submit" className="small" disabled={pending}>
          {pending ? "Sending…" : "Start work"}
        </button>
      </form>
      {state && !state.ok && (
        <p className="error" style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
          {state.message}
        </p>
      )}
    </>
  );
}
