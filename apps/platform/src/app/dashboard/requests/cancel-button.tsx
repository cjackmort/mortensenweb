"use client";

import { useActionState, useState } from "react";
import { cancelRequest, type CancelRequestResult } from "./actions";

/**
 * Calling off a request.
 *
 * Two clicks, not one. Cancelling throws away work the agent may already have
 * done and closes the pull request behind it, and it sits in a list of requests
 * a client is scrolling through — a single mis-tap next to "See this change"
 * would be an easy and annoying mistake to make.
 *
 * The reason box is optional and unlabelled as required. Forcing someone to
 * justify changing their mind before the button works is a good way to make
 * them abandon the form and leave the request open instead, which is the exact
 * state the one-at-a-time rule needs them to be able to escape.
 */
export function CancelRequestButton({
  requestPublicId,
  hasPreview,
}: {
  requestPublicId: string;
  /** Drives the warning: an existing preview means work to be discarded. */
  hasPreview: boolean;
}) {
  const [state, action, pending] = useActionState<
    CancelRequestResult | null,
    FormData
  >(cancelRequest, null);

  const [confirming, setConfirming] = useState(false);

  if (state?.ok) {
    return (
      <p className="muted" style={{ margin: "0.6rem 0 0", fontSize: "0.9rem" }}>
        {state.message}
      </p>
    );
  }

  if (!confirming) {
    return (
      <p style={{ margin: "0.6rem 0 0" }}>
        {state && !state.ok && <span className="error">{state.message}</span>}
        <button
          type="button"
          className="linklike"
          onClick={() => setConfirming(true)}
        >
          Cancel this request
        </button>
      </p>
    );
  }

  return (
    <form action={action} style={{ marginTop: "0.75rem" }}>
      <input type="hidden" name="requestPublicId" value={requestPublicId} />

      <p style={{ margin: "0 0 0.5rem" }}>
        {hasPreview
          ? "This will call off the change and discard the preview we built. Nothing on your live site changes."
          : "This will call off the change. Nothing on your live site changes."}
      </p>

      <label htmlFor={`cancel-reason-${requestPublicId}`}>
        Anything we should know? (optional)
      </label>
      <textarea
        id={`cancel-reason-${requestPublicId}`}
        name="reason"
        placeholder="Changed my mind / going to ask for something different…"
      />
      <p className="field-hint">
        This month&rsquo;s change goes back on your allowance.
      </p>

      {state && !state.ok && <p className="error">{state.message}</p>}

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Cancelling…" : "Yes, cancel it"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Keep it
        </button>
      </div>
    </form>
  );
}
