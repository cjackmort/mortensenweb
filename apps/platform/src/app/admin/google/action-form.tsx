"use client";

import { useActionState } from "react";

/**
 * A form for one operator action on a Google profile, with Google's answer
 * shown right under it.
 *
 * Several buttons can share a form (`buttons`): each submits `intent=<value>`,
 * so "Save draft" and "Post reply" act on the same textarea without two
 * copies of it. A button with `confirm` asks first — posting is public and
 * stays up under the client's name.
 */

export type ActionResult = { ok: boolean; message: string };

export interface ActionButton {
  label: string;
  value: string;
  pendingLabel?: string;
  confirm?: string;
  secondary?: boolean;
}

export function ActionForm({
  action,
  hidden = {},
  children,
  buttons,
  className,
}: {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  hidden?: Record<string, string>;
  children?: React.ReactNode;
  buttons: ActionButton[];
  className?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);

  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(event) => {
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const button = buttons.find((b) => b.value === submitter?.value) ?? (buttons.length === 1 ? buttons[0] : undefined);
        if (button?.confirm && !window.confirm(button.confirm)) event.preventDefault();
      }}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <div className="gp-inline-actions">
        {buttons.map((button) => (
          <button
            key={button.value}
            type="submit"
            name="intent"
            value={button.value}
            className={button.secondary ? "secondary" : undefined}
            disabled={pending}
          >
            {pending ? (button.pendingLabel ?? "Working…") : button.label}
          </button>
        ))}
      </div>
    </form>
  );
}
