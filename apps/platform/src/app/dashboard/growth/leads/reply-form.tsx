"use client";

import { useActionState, useState } from "react";
import { buildMailDraft, gmailComposeHref, mailtoHref } from "@/lib/growth/lead-reply";
import { sendLeadReplyAction, type LeadActionResult } from "./actions";

/**
 * Write back to the customer.
 *
 * The words are typed here once and can go three ways. Two open a draft the
 * client sends themselves — their email app, or Gmail in the browser — so the
 * reply leaves from their own address with nothing to set up. The third,
 * shown only when the server can send, posts it from the portal under the
 * business's name. The notes under the box say, before anything is sent,
 * which address the customer will see and where their answer will land — the
 * things a client would otherwise have to take on trust.
 *
 * The portal never learns whether a draft opened in an email app was sent, so
 * it marks nothing; the status buttons on the enquiry are where the client
 * says so.
 */
export function LeadReplyForm({
  publicId,
  customerEmail,
  businessName,
  replyTo,
  original,
  portalSend,
  readOnly,
}: {
  publicId: string;
  customerEmail: string;
  businessName: string;
  replyTo: string | null;
  /** What they wrote, for the quote under the reply. */
  original: { message: string | null; receivedOn: string } | null;
  /** The server has a sender address and somewhere for answers to go. */
  portalSend: boolean;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<LeadActionResult | null, FormData>(
    sendLeadReplyAction,
    null,
  );
  const [body, setBody] = useState("");
  const [cleared, setCleared] = useState<LeadActionResult | null>(null);

  // Clear the box once a reply has gone from here, so pressing send twice
  // cannot send the same words twice. Done while rendering, against the
  // result that caused it, rather than in an effect that would re-render.
  if (state?.ok && state !== cleared) {
    setCleared(state);
    setBody("");
  }

  const draft = buildMailDraft({ to: customerEmail, businessName, body, original });
  const disabled = readOnly || pending;
  const stopWhenReadOnly = readOnly
    ? (event: React.MouseEvent<HTMLAnchorElement>) => event.preventDefault()
    : undefined;

  return (
    <form action={formAction}>
      <input type="hidden" name="lead" value={publicId} />
      <label htmlFor="reply-body">Reply to {customerEmail}</label>
      <textarea
        id="reply-body"
        name="body"
        rows={6}
        maxLength={5000}
        required={portalSend}
        disabled={disabled}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Hi, thanks for getting in touch…"
      />
      <p className="field-hint lead-reply-hint">
        Your email app opens with this written in and addressed to them, with what they
        wrote quoted underneath. You press send there, from your own address.
      </p>

      <div className="actions lead-reply-actions">
        <a
          className={`button${readOnly ? " is-disabled" : ""}`}
          href={mailtoHref(draft)}
          aria-disabled={readOnly || undefined}
          onClick={stopWhenReadOnly}
        >
          Open in your email app
        </a>
        <a
          className={`button secondary${readOnly ? " is-disabled" : ""}`}
          href={gmailComposeHref(draft)}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={readOnly || undefined}
          onClick={stopWhenReadOnly}
        >
          Open in Gmail
        </a>
        {portalSend && (
          <button type="submit" className="secondary" disabled={disabled}>
            {pending ? "Sending…" : "Send from here instead"}
          </button>
        )}
      </div>

      {portalSend && (
        <p className="field-hint lead-reply-hint">
          Sent from here, it goes out as <strong>{businessName}</strong>
          {replyTo ? (
            <>
              , their answer comes to <strong>{replyTo}</strong>, and you get a copy of what you
              sent.
            </>
          ) : (
            "."
          )}
        </p>
      )}
      <p className="field-hint lead-reply-hint">
        Once it has gone, mark the enquiry <strong>Contacted</strong> under Status.
      </p>

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
