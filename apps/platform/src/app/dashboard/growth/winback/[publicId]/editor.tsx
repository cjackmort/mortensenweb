"use client";

import { useActionState, useState } from "react";
import type { SaveResult } from "@/db/repositories/client/winback-campaigns";
import { FIRST_NAME_TOKEN, LIMITS } from "@/lib/winback/email";
import { approveCampaignAction, deleteDraftAction, saveDraftAction } from "../actions";
import { EmailPreview } from "../parts";

/**
 * The draft, editable, beside the email exactly as a customer will get it.
 *
 * Save and Approve post the same fields, so what is approved is what is on
 * the screen — not whatever was last saved. Approving asks once, in words,
 * because it cannot be undone after the first email goes.
 */

export interface EditorProps {
  publicId: string;
  initial: { name: string; subject: string; body: string; offer: string; offerExpiresOn: string };
  identity: { fromName: string; replyTo: string | null; postalAddress: string | null; senderAddress: string };
  sample: { email: string; name: string | null };
  reachable: number;
  /** Why approving is impossible right now, or null. */
  blocked: string | null;
  today: string;
  readOnly: boolean;
}

export function CampaignEditor({ publicId, initial, identity, sample, reachable, blocked, today, readOnly }: EditorProps) {
  const [values, setValues] = useState(initial);
  const [scheduleDay, setScheduleDay] = useState("");
  const [saved, saveAction, saving] = useActionState<SaveResult | null, FormData>(saveDraftAction, null);
  const [approved, approveAction, approving] = useActionState<SaveResult | null, FormData>(approveCampaignAction, null);
  const result = approved ?? saved;
  const errors = result && !result.ok ? (result.errors ?? {}) : {};
  const busy = saving || approving || readOnly;

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: event.target.value }));

  const who = `${reachable} ${reachable === 1 ? "customer" : "customers"}`;
  const confirmText = scheduleDay
    ? `Send this to ${who} on ${scheduleDay}? Once approved it can't be edited, only cancelled.`
    : `Send this to ${who} now? Once approved it can't be edited, and it starts going out within minutes.`;

  return (
    <div className="winback-layout">
      <section className="panel">
        <div className="panel-head">
          <h2>Edit</h2>
        </div>
        <form className="panel-body winback-form" action={saveAction}>
          <input type="hidden" name="campaign" value={publicId} />

          <label htmlFor="wb-subject">Subject line</label>
          <input id="wb-subject" type="text" name="subject" value={values.subject} onChange={set("subject")} maxLength={LIMITS.subject} required />
          {errors.subject && <p className="error">{errors.subject}</p>}

          <label htmlFor="wb-body">Email</label>
          <textarea id="wb-body" name="body" value={values.body} onChange={set("body")} maxLength={LIMITS.body} required />
          <p className="field-hint">
            <code>{FIRST_NAME_TOKEN}</code> becomes each customer&rsquo;s first name, or &ldquo;there&rdquo; when we
            don&rsquo;t have it. Your address and an unsubscribe link are added at the bottom.
          </p>
          {errors.body && <p className="error">{errors.body}</p>}

          <div className="winback-row">
            <div>
              <label htmlFor="wb-offer">Offer (optional)</label>
              <input id="wb-offer" type="text" name="offer" value={values.offer} onChange={set("offer")} maxLength={LIMITS.offer} placeholder="e.g. $20 off a tune-up booked this month" />
            </div>
            <div>
              <label htmlFor="wb-expires">Offer ends</label>
              <input id="wb-expires" type="date" name="offerExpiresOn" value={values.offerExpiresOn} onChange={set("offerExpiresOn")} min={today} />
            </div>
          </div>
          {(errors.offer || errors.offerExpiresOn) && <p className="error">{errors.offer ?? errors.offerExpiresOn}</p>}

          <div className="winback-row">
            <div>
              <label htmlFor="wb-name">Name, just for you</label>
              <input id="wb-name" type="text" name="name" value={values.name} onChange={set("name")} maxLength={LIMITS.name} />
            </div>
            <div>
              <label htmlFor="wb-day">Send on (optional)</label>
              <input id="wb-day" type="date" name="scheduleDay" value={scheduleDay} onChange={(e) => setScheduleDay(e.target.value)} min={today} />
            </div>
          </div>
          <p className="field-hint">Leave the date empty to send as soon as you approve. A date sends from 9am that day.</p>

          {result && (
            <p className={result.ok ? "notice notice-success" : "error"} role="status">
              {result.message}
            </p>
          )}
          {blocked && <p className="notice notice-warning">{blocked}</p>}

          <div className="winback-buttons">
            <button
              type="submit"
              formAction={approveAction}
              disabled={busy || Boolean(blocked)}
              onClick={(event) => {
                if (!window.confirm(confirmText)) event.preventDefault();
              }}
            >
              {approving ? "Approving…" : scheduleDay ? `Approve for ${who}` : `Approve and send to ${who}`}
            </button>
            <button type="submit" className="secondary" disabled={busy}>
              {saving ? "Saving…" : "Save draft"}
            </button>
          </div>
        </form>
        <form
          className="panel-body"
          action={deleteDraftAction}
          onSubmit={(event) => {
            if (!window.confirm("Delete this draft?")) event.preventDefault();
          }}
        >
          <input type="hidden" name="campaign" value={publicId} />
          <button type="submit" className="secondary small" disabled={busy}>
            Delete draft
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>What {sample.name?.split(" ")[0] ?? "a customer"} will see</h2>
        </div>
        <div className="panel-body">
          <EmailPreview
            campaign={{
              subject: values.subject,
              body: values.body,
              offer: values.offer || null,
              offerExpiresOn: values.offer && values.offerExpiresOn ? values.offerExpiresOn : null,
              fromName: identity.fromName,
              replyTo: identity.replyTo ?? "",
              postalAddress: identity.postalAddress ?? "Your postal address goes here",
            }}
            sample={sample}
            senderAddress={identity.senderAddress}
          />
        </div>
      </section>
    </div>
  );
}
