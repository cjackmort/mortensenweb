"use client";

import { useActionState } from "react";
import { refreshSearchAction, type RefreshResult } from "./actions";

/** "Look again now": reads Search Console for today and says what happened, in one line. */
export function RefreshControls({ readOnly, label = "Look again now" }: { readOnly: boolean; label?: string }) {
  const [state, action, pending] = useActionState<RefreshResult | null>(refreshSearchAction, null);

  return (
    <div>
      <form action={action} className="actions">
        <button type="submit" className="secondary small" disabled={readOnly || pending}>
          {pending ? "Reading Google…" : label}
        </button>
      </form>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}
