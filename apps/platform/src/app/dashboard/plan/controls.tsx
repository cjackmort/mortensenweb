"use client";

import { useActionState } from "react";
import type { ChangeResult } from "@/db/repositories/client/growth";

/**
 * One button that changes something about the client's plan, with an
 * optional "are you sure" and the outcome shown right beside it.
 *
 * Money changes ask first. A button that adds $35 a month to somebody's card
 * should not be one stray tap away from doing it.
 */
export function PlanActionButton({
  action,
  fields,
  label,
  pendingLabel = "Working…",
  confirm,
  variant = "primary",
  disabled = false,
}: {
  action: (previous: ChangeResult | null, form: FormData) => Promise<ChangeResult>;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ChangeResult | null, FormData>(action, null);

  return (
    <form
      action={formAction}
      className="plan-action"
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={variant === "secondary" ? "secondary" : undefined}
        disabled={pending || disabled}
      >
        {pending ? pendingLabel : label}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
