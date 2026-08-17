"use client";

import { useActionState } from "react";
import {
  closeRequestAction,
  startAutomatedWork,
  type CloseResult,
  type DispatchResult,
} from "./actions";

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
  const [closeState, closeAction, closing] = useActionState<
    CloseResult | null,
    FormData
  >(closeRequestAction, null);

  // Mirrors DISPATCHABLE in the repository layer. Kept narrow on purpose: the
  // real gate is server-side, and this only decides whether to offer a button
  // that would be refused.
  const dispatchable = ["submitted", "triaged", "approved"].includes(status);

  // Closing is refused once work is in flight, because it would not stop the
  // run — only stop anyone watching for its pull request.
  const closable = !["dispatched", "in_progress", "pr_open", "closed"].includes(
    status,
  );

  if (state?.ok) {
    return <span className="pill pill-success">Sent to the agent</span>;
  }
  if (closeState?.ok) {
    return <span className="muted">Closed</span>;
  }

  if (!dispatchable && !closable) {
    return <span className="muted">&mdash;</span>;
  }

  return (
    <>
      <div className="actions">
        {dispatchable && (
          <form action={action}>
            <input
              type="hidden"
              name="requestPublicId"
              value={requestPublicId}
            />
            <button type="submit" className="small" disabled={pending}>
              {pending ? "Sending…" : "Start work"}
            </button>
          </form>
        )}

        {closable && (
          <form action={closeAction}>
            <input
              type="hidden"
              name="requestPublicId"
              value={requestPublicId}
            />
            <input
              type="hidden"
              name="reason"
              value="Closed by the agency without action."
            />
            <button
              type="submit"
              className="small secondary"
              disabled={closing || pending}
            >
              {closing ? "Closing…" : "Close"}
            </button>
          </form>
        )}
      </div>

      {[state, closeState].map(
        (r, i) =>
          r &&
          !r.ok && (
            <p
              key={i}
              className="error"
              style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}
            >
              {r.message}
            </p>
          ),
      )}
    </>
  );
}
