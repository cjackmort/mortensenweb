"use client";

import { useActionState, useState } from "react";
import type { ReviewResult } from "@/db/repositories/client/reviews";
import { DEFAULT_TEMPLATE, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH, type ReviewTemplate } from "@/lib/reviews/template";
import { saveReviewMessageAction } from "./actions";

const DAYS = Array.from({ length: 14 }, (_, i) => i + 1);

/**
 * The wording of a request and its reminder, and when the reminder goes.
 *
 * The Google button and the unsubscribe line are added around whatever is
 * written here, so the note says so: a client who deletes "review" from the
 * text has not removed the link. The server refuses wording that asks only
 * happy customers or offers something in return, and says why.
 */
export function ReviewMessageForm({
  template,
  reminderDays,
  remindersEnabled,
  readOnly,
}: {
  template: ReviewTemplate;
  reminderDays: number;
  remindersEnabled: boolean;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ReviewResult | null, FormData>(saveReviewMessageAction, null);
  const [values, setValues] = useState(template);
  const disabled = readOnly || pending;
  const set = (key: keyof ReviewTemplate) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <form action={formAction} className="review-message">
      <label htmlFor="review-subject">Subject</label>
      <input id="review-subject" name="subject" value={values.subject} onChange={set("subject")} maxLength={MAX_SUBJECT_LENGTH} required disabled={disabled} />

      <label htmlFor="review-body">Message</label>
      <textarea id="review-body" name="body" rows={8} value={values.body} onChange={set("body")} maxLength={MAX_BODY_LENGTH} required disabled={disabled} />
      <p className="field-hint">
        <code>{"{first_name}"}</code>, <code>{"{name}"}</code> and <code>{"{business}"}</code> are filled in for each
        customer. A &ldquo;Leave a review on Google&rdquo; button and an unsubscribe line are always added underneath.
      </p>

      <label htmlFor="review-reminder">Reminder</label>
      <textarea id="review-reminder" name="reminderBody" rows={6} value={values.reminderBody} onChange={set("reminderBody")} maxLength={MAX_BODY_LENGTH} required disabled={disabled} />

      <div className="review-reminder-when">
        <label className="review-consent">
          <input type="checkbox" name="remindersEnabled" defaultChecked={remindersEnabled} disabled={disabled} />
          <span>Send one reminder if they don&rsquo;t click, after</span>
        </label>
        <select name="reminderDays" defaultValue={String(reminderDays)} disabled={disabled} aria-label="Days before the reminder">
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d} {d === 1 ? "day" : "days"}
            </option>
          ))}
        </select>
      </div>

      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <div className="review-actions">
        <button type="submit" disabled={disabled}>
          {pending ? "Saving…" : "Save wording"}
        </button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => setValues(DEFAULT_TEMPLATE)}>
          Use our wording
        </button>
      </div>
      <p className="hint">
        Google does not allow asking only happy customers, asking for five stars, or offering anything for a review —
        so ask everyone for an honest one.
      </p>
    </form>
  );
}
