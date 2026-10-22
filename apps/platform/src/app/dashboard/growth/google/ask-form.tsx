"use client";

import { useActionState, useEffect, useRef } from "react";
import type { AskResult } from "@/db/repositories/client/google-profile";
import { askForGoogleChangeAction } from "./actions";

/** "Change my holiday hours" — straight into our queue. */
export function AskForChangeForm({ readOnly }: { readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<AskResult | null, FormData>(askForGoogleChangeAction, null);
  const form = useRef<HTMLFormElement>(null);

  // Cleared once sent, so a second press cannot send the same ask twice.
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction}>
      <label htmlFor="google-ask">What should change on your Google profile?</label>
      <textarea
        id="google-ask"
        name="body"
        rows={4}
        maxLength={2000}
        required
        disabled={readOnly || pending}
        placeholder="Closed Thursday Nov 26 for Thanksgiving, open 8–noon on the 27th."
      />
      <p className="field-hint">Hours, holiday closures, a new phone number, a post you want up. We make the change and mark it done here.</p>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={readOnly || pending}>
        {pending ? "Sending…" : "Send to us"}
      </button>
    </form>
  );
}
