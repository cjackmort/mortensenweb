"use client";

import { useActionState } from "react";
import {
  closeRequestAction,
  reclaimStalledRequestAction,
  startAutomatedWork,
  type CloseResult,
  type DispatchResult,
  type ReclaimResult,
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
  overdue,
}: {
  requestPublicId: string;
  status: string;
  /** The latest run is past its timeout and still claims to be going. */
  overdue: boolean;
}) {
  const [state, action, pending] = useActionState<
    DispatchResult | null,
    FormData
  >(startAutomatedWork, null);
  const [closeState, closeAction, closing] = useActionState<
    CloseResult | null,
    FormData
  >(closeRequestAction, null);
  const [reclaimState, reclaimAction, reclaiming] = useActionState<
    ReclaimResult | null,
    FormData
  >(reclaimStalledRequestAction, null);

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
  if (reclaimState?.ok) {
    return <span className="pill pill-warning">Marked failed</span>;
  }

  // The gap this closes: a dispatched request offers neither button, so a run
  // the watchdog never reclaimed left the operator with nothing to click. The
  // control appears only once the run is genuinely late — the server checks
  // the same thing, and refuses a run still inside its timeout.
  if (!dispatchable && !closable && !overdue) {
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

        {overdue && !dispatchable && (
          <form action={reclaimAction}>
            <input
              type="hidden"
              name="requestPublicId"
              value={requestPublicId}
            />
            <button
              type="submit"
              className="small secondary"
              disabled={reclaiming}
              title="This run passed its timeout and the schedule has not reclaimed it."
            >
              {reclaiming ? "Reclaiming…" : "Mark failed"}
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

      {[state, closeState, reclaimState].map(
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
