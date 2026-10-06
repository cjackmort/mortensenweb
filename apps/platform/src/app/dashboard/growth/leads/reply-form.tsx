"use client";

import { useActionState, useEffect, useRef } from "react";
import { sendLeadReplyAction, type LeadActionResult } from "./actions";

/**
 * Write back to the customer. The note under the box says, before anything is
 * sent, whose name the email carries and where the customer's answer will go —
 * the two things a client would otherwise have to take on trust.
 */
export function LeadReplyForm({
  publicId,
  customerEmail,
  businessName,
  replyTo,
  readOnly,
}: {
  publicId: string;
  customerEmail: string;
  businessName: string;
  replyTo: string | null;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<LeadActionResult | null, FormData>(
    sendLeadReplyAction,
    null,
  );
  const form = useRef<HTMLFormElement>(null);

  // Clear the box once a reply has gone, so pressing send twice cannot send
  // the same words twice.
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction}>
      <input type="hidden" name="lead" value={publicId} />
      <label htmlFor="reply-body">Reply to {customerEmail}</label>
      <textarea
        id="reply-body"
        name="body"
        rows={6}
        maxLength={5000}
        required
        disabled={readOnly || pending}
        placeholder="Hi, thanks for getting in touch…"
      />
      <p className="field-hint lead-reply-hint">
        Sent as <strong>{businessName}</strong>.{" "}
        {replyTo ? (
          <>
            Their answer comes to <strong>{replyTo}</strong>, and you get a copy of what you sent.
          </>
        ) : null}
      </p>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={readOnly || pending}>
        {pending ? "Sending…" : "Send reply"}
      </button>
    </form>
  );
}
