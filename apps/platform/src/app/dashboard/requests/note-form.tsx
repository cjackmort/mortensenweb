"use client";

import { useActionState, useState } from "react";
import { addNote, type NoteResult } from "./actions";

/**
 * "I forgot to mention…"
 *
 * A single box under an in-progress request. Collapsed to a link until it is
 * wanted, because most requests need nothing added and an open textarea on
 * every one reads as a demand. Submitting records the note and closes the box
 * with a one-line confirmation; the timeline above picks it up on the next
 * render.
 */
export function NoteForm({ requestPublicId }: { requestPublicId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<NoteResult | null, FormData>(
    addNote,
    null,
  );

  if (state?.ok) {
    return (
      <p className="field-hint" style={{ margin: "0.6rem 0 0" }}>
        {state.message}
      </p>
    );
  }

  if (!open) {
    return (
      <p style={{ margin: "0.6rem 0 0", fontSize: "0.9rem" }}>
        <button type="button" className="link" onClick={() => setOpen(true)}>
          Add a note to this request
        </button>
      </p>
    );
  }

  return (
    <form action={action} style={{ marginTop: "0.75rem" }}>
      <input type="hidden" name="requestPublicId" value={requestPublicId} />
      <label htmlFor={`note-${requestPublicId}`}>Anything to add?</label>
      <textarea
        id={`note-${requestPublicId}`}
        name="note"
        rows={3}
        placeholder="The price on that one is $120 / use the second photo for the banner…"
        maxLength={2000}
        required
      />
      {state && !state.ok && <p className="error">{state.message}</p>}
      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add note"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
