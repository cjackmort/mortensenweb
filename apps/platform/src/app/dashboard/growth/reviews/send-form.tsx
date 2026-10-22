"use client";

import { useActionState, useState } from "react";
import type { ReviewResult } from "@/db/repositories/client/reviews";
import { sendReviewRequestAction } from "./actions";

export interface LeadChoice {
  publicId: string;
  label: string;
  name: string;
  email: string;
  phone: string;
}

/**
 * "Ask for a review": a name and an email, or pick someone who sent an
 * enquiry. The note under the button says, before anything is sent, whose
 * name it goes out under, where replies land, and that one reminder follows —
 * the things a client would otherwise have to take on trust.
 *
 * The phone field and the consent box only exist when texting is set up. The
 * box is not pre-ticked: the client has to say, each time, that this customer
 * agreed to a text.
 */
export function SendReviewForm({
  leads,
  initialLead,
  smsEnabled,
  businessName,
  replyTo,
  reminderNote,
  readOnly,
}: {
  leads: LeadChoice[];
  initialLead: string | null;
  smsEnabled: boolean;
  businessName: string;
  replyTo: string | null;
  reminderNote: string;
  readOnly: boolean;
}) {
  const start = leads.find((l) => l.publicId === initialLead) ?? null;
  const [lead, setLead] = useState(start?.publicId ?? "");
  const [name, setName] = useState(start?.name ?? "");
  const [email, setEmail] = useState(start?.email ?? "");
  const [phone, setPhone] = useState(start?.phone ?? "");

  // Clear the form once it has gone, so pressing send twice cannot ask twice.
  // React resets the uncontrolled consent box itself after the action.
  const [state, formAction, pending] = useActionState<ReviewResult | null, FormData>(async (previous, form) => {
    const result = await sendReviewRequestAction(previous, form);
    if (result.ok) {
      setLead("");
      setName("");
      setEmail("");
      setPhone("");
    }
    return result;
  }, null);

  function pick(publicId: string) {
    const chosen = leads.find((l) => l.publicId === publicId);
    setLead(publicId);
    setName(chosen?.name ?? "");
    setEmail(chosen?.email ?? "");
    setPhone(chosen?.phone ?? "");
  }

  const disabled = readOnly || pending;

  return (
    <form action={formAction} className="review-send">
      {leads.length > 0 && (
        <>
          <label htmlFor="review-lead">From your enquiries</label>
          <select id="review-lead" name="lead" value={lead} onChange={(e) => pick(e.target.value)} disabled={disabled}>
            <option value="">Someone else</option>
            {leads.map((l) => (
              <option key={l.publicId} value={l.publicId}>
                {l.label}
              </option>
            ))}
          </select>
        </>
      )}

      <div className="review-send-fields">
        <div>
          <label htmlFor="review-name">Customer&rsquo;s name</label>
          <input id="review-name" name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required disabled={disabled} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="review-email">Email</label>
          <input id="review-email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={disabled} autoComplete="off" required={!smsEnabled} />
        </div>
        {smsEnabled && (
          <div>
            <label htmlFor="review-phone">Mobile number</label>
            <input id="review-phone" name="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={disabled} autoComplete="off" />
          </div>
        )}
      </div>

      {smsEnabled && (
        <label className="review-consent">
          <input type="checkbox" name="smsConsent" disabled={disabled || !phone} />
          <span>They agreed to get a text from us. (The law requires it before texting a customer.)</span>
        </label>
      )}

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}

      <button type="submit" disabled={disabled}>
        {pending ? "Sending…" : "Send request"}
      </button>
      <p className="field-hint review-send-note">
        Sent as <strong>{businessName}</strong>
        {replyTo ? (
          <>
            , and replies go to <strong>{replyTo}</strong>
          </>
        ) : null}
        . {reminderNote}
      </p>
    </form>
  );
}
