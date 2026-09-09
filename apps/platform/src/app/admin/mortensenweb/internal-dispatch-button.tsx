"use client";

import { useActionState } from "react";
import {
  startInternalWorkAction,
  type InternalDispatchResult,
} from "./actions";

/**
 * Starting the agent on the agency's own request.
 *
 * The operator queue has had this control for client requests. This tab never
 * did, because `listAllChangeRequests` filters the internal client out of that
 * queue by design — so the agency's own requests were the one kind nobody
 * could start, and they sat at `submitted` looking identical to work already
 * under way.
 *
 * The gate mirrors `DISPATCHABLE` in the repository layer, exactly as the
 * operator queue's button does. The real refusal is server-side; this only
 * decides whether to offer a button that would be refused.
 */
export function InternalDispatchButton({
  requestPublicId,
  status,
}: {
  requestPublicId: string;
  status: string;
}) {
  const [state, action, pending] = useActionState<
    InternalDispatchResult | null,
    FormData
  >(startInternalWorkAction, null);

  const dispatchable = ["submitted", "triaged", "approved"].includes(status);

  if (state?.ok) {
    return (
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
        <span className="pill pill-success">Sent to the agent</span>{" "}
        {state.issueUrl && (
          <a href={state.issueUrl} target="_blank" rel="noopener noreferrer">
            View the issue
          </a>
        )}
      </p>
    );
  }

  if (!dispatchable) return null;

  return (
    <>
      <form action={action} style={{ display: "inline" }}>
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
