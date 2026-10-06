"use client";

import { useActionState } from "react";
import type { LeadStatus } from "@/db/repositories/client/leads";
import { deleteLeadAction, setLeadStatusAction, type LeadActionResult } from "./actions";

const CHOICES: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "Not contacted" },
  { value: "contacted", label: "Contacted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "archived", label: "Archive" },
];

/**
 * Where the enquiry stands. One button per status rather than a select and a
 * save button: on a phone, the status *is* the action, and a second tap to
 * confirm a choice already made is friction for nothing.
 */
export function LeadStatusForm({
  publicId,
  current,
  readOnly,
}: {
  publicId: string;
  current: LeadStatus;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<LeadActionResult | null, FormData>(
    setLeadStatusAction,
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="lead" value={publicId} />
      <div className="lead-status-choices" role="group" aria-label="Status">
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="submit"
            name="status"
            value={choice.value}
            className={choice.value === current ? "" : "secondary"}
            aria-pressed={choice.value === current}
            disabled={pending || readOnly}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function DeleteLeadForm({ publicId, readOnly }: { publicId: string; readOnly: boolean }) {
  return (
    <form
      action={deleteLeadAction}
      onSubmit={(event) => {
        if (!window.confirm("Delete this enquiry and the person’s details from your portal? This cannot be undone.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="lead" value={publicId} />
      <button type="submit" className="secondary small" disabled={readOnly}>
        Delete enquiry
      </button>
    </form>
  );
}
