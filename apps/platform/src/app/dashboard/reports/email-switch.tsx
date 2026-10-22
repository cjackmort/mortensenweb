"use client";

import { useActionState } from "react";
import { setReportEmailsAction, type ReportEmailsResult } from "./actions";

/** One button that says what it will do, rather than a checkbox and a save. */
export function ReportEmailSwitch({ on }: { on: boolean }) {
  const [state, formAction, pending] = useActionState<ReportEmailsResult | null, FormData>(
    setReportEmailsAction,
    null,
  );

  return (
    <form action={formAction}>
      <p style={{ marginTop: 0 }}>
        {on
          ? "We email a short summary to everyone on your portal account on the 1st of each month."
          : "Monthly emails are off. Your reports still appear here each month."}
      </p>
      <input type="hidden" name="emails" value={on ? "off" : "on"} />
      <button type="submit" className={on ? "secondary" : ""} disabled={pending}>
        {on ? "Stop the monthly email" : "Email me each month"}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
