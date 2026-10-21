"use client";

import { useActionState } from "react";
import type { ReportActionResult } from "@/db/repositories/admin/reports";
import { reportAction } from "./report-actions";

export type ReportIntent = "rebuild" | "resend" | "emails-on" | "emails-off";

/** One report button: build, re-send, or switch the email. Says what happened. */
export function ReportButton({
  clientPublicId,
  period = "",
  intent,
  label,
  secondary = false,
  confirm,
}: {
  clientPublicId: string;
  period?: string;
  intent: ReportIntent;
  label: string;
  secondary?: boolean;
  /** Asked before an action the client will see (an email). */
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<ReportActionResult | null, FormData>(reportAction, null);
  return (
    <form
      action={formAction}
      className="plan-action"
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input type="hidden" name="period" value={period} />
      <input type="hidden" name="intent" value={intent} />
      <button type="submit" className={secondary ? "secondary small" : "small"} disabled={pending}>
        {pending ? "Working…" : label}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
