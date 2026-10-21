"use client";

import { useActionState } from "react";
import type { ChangeResult } from "@/db/repositories/client/growth";

/**
 * One button that changes something about the client's plan, with an
 * optional "are you sure" and the outcome shown right beside it.
 *
 * Adding money asks first. A button that adds $35 a month to somebody's card
 * should not be one stray tap away from doing it. Cancelling never asks: it
 * must be no harder than signing up, so it is one click answered by
 * "Ends <date> · Undo" (see `CancelledUntil`).
 */
export function PlanActionButton({
  action,
  fields,
  label,
  pendingLabel = "Working…",
  confirm,
  variant = "primary",
  disabled = false,
  showSuccess = true,
}: {
  action: (previous: ChangeResult | null, form: FormData) => Promise<ChangeResult>;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  variant?: "primary" | "secondary" | "link";
  disabled?: boolean;
  /** Off where the page itself changes to show the outcome. */
  showSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ChangeResult | null, FormData>(action, null);

  return (
    <form
      action={formAction}
      className={variant === "link" ? "plan-action plan-action--inline" : "plan-action"}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={variant === "primary" ? undefined : variant}
        disabled={pending || disabled}
      >
        {pending ? pendingLabel : label}
      </button>
      {state && (!state.ok || showSuccess) && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * What a cancelled plan or add-on shows: the date it ends and an Undo that
 * works until then. `endsOn` is formatted by the server, in the business's
 * time zone.
 */
export function CancelledUntil({
  endsOn,
  action,
  fields,
  note,
}: {
  endsOn: string;
  action: (previous: ChangeResult | null, form: FormData) => Promise<ChangeResult>;
  fields: Record<string, string>;
  note?: string;
}) {
  return (
    <span className="plan-ends" role="status">
      <span>
        Ends {endsOn}
        {note ? <span className="muted"> · {note}</span> : null}
      </span>
      <span aria-hidden="true">·</span>
      <PlanActionButton action={action} fields={fields} label="Undo" pendingLabel="Undoing…" variant="link" showSuccess={false} />
    </span>
  );
}
