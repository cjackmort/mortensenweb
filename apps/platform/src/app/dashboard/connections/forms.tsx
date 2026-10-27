"use client";

import { useActionState } from "react";
import { auditNowAction, disconnectAction, type ConnectionActionResult } from "./actions";

/** The two buttons on a connected card. Each says what happened, in one line. */
export function ConnectedControls({ provider, readOnly }: { provider: string; readOnly: boolean }) {
  const [auditState, auditAction, auditing] = useActionState<ConnectionActionResult | null, FormData>(
    auditNowAction,
    null,
  );
  const [dropState, dropAction, dropping] = useActionState<ConnectionActionResult | null, FormData>(
    disconnectAction,
    null,
  );
  const state = dropState ?? auditState;

  return (
    <div>
      <div className="actions">
        <form action={auditAction}>
          <input type="hidden" name="provider" value={provider} />
          <button type="submit" className="secondary small" disabled={readOnly || auditing || dropping}>
            {auditing ? "Looking…" : "Look again now"}
          </button>
        </form>
        <form action={dropAction}>
          <input type="hidden" name="provider" value={provider} />
          <button type="submit" className="secondary small" disabled={readOnly || auditing || dropping}>
            {dropping ? "Disconnecting…" : "Disconnect"}
          </button>
        </form>
      </div>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}
