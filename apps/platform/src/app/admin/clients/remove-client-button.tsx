"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { removeClientAction, type RemoveClientResult } from "./remove-actions";

/**
 * "Remove client", behind a confirmation that names the client.
 *
 * Two steps, like the request-cancel button: the action sits in a tile the
 * operator is scrolling past, and one mis-click should not take a client off
 * the list. The confirmation says what removing does and does not do, because
 * "remove" reads as "delete" and nothing here deletes.
 *
 * Focus follows the step: opening the confirmation lands on "Keep client", the
 * safe choice, and cancelling returns to the button that opened it. On success
 * the action redirects and this unmounts, so the page it lands on takes focus.
 */
export function RemoveClientButton({
  clientPublicId,
  clientName,
  blockedReason,
}: {
  clientPublicId: string;
  clientName: string;
  /** Why removal is not available, when it is not. Shown instead of the button. */
  blockedReason?: string | null;
}) {
  const [state, action, pending] = useActionState<RemoveClientResult, FormData>(
    removeClientAction,
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) openRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (blockedReason) {
    return (
      <div className="remove-client">
        <button type="button" className="secondary small" disabled aria-describedby={`remove-blocked-${clientPublicId}`}>
          Remove client
        </button>
        <p id={`remove-blocked-${clientPublicId}`} className="field-hint">
          {blockedReason}
        </p>
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="remove-client">
        {state && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        <button
          ref={openRef}
          type="button"
          className="linklike"
          onClick={() => setConfirming(true)}
        >
          Remove client
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="remove-client remove-client-confirm">
      <input type="hidden" name="clientPublicId" value={clientPublicId} />

      <p style={{ margin: "0 0 0.5rem" }}>
        <strong>Remove {clientName}?</strong> They will disappear from Clients and
        from the billing totals. Their payments and invoices are kept, and
        their site, repository and domain are not touched. You can restore them
        from <em>Archived clients</em> at the bottom of the page.
      </p>

      {state && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="danger small" disabled={pending}>
          {pending ? "Removing…" : `Yes, remove ${clientName}`}
        </button>
        <button
          ref={keepRef}
          type="button"
          className="secondary small"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Keep client
        </button>
      </div>
    </form>
  );
}
