"use client";

import { useActionState } from "react";
import { disconnectCalendarAction, type AvailabilityActionResult } from "./actions";

/** Disconnect, with the one line that says what it did. */
export function DisconnectCalendar({ readOnly }: { readOnly: boolean }) {
  const [state, action, pending] = useActionState<AvailabilityActionResult | null, FormData>(disconnectCalendarAction, null);
  return (
    <>
      <form action={action}>
        <button type="submit" className="secondary small" disabled={readOnly || pending}>
          {pending ? "Disconnecting…" : "Disconnect"}
        </button>
      </form>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </>
  );
}
