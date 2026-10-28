"use client";

import { useActionState } from "react";
import type { ListingStepView, MarkResult, SiteChecklist } from "@/lib/listings/checklist";
import { MAX_LISTING_NOTE_CHARS } from "@/lib/listings/steps";
import "./listing-checklist.css";

/**
 * The Get listed checklist, as both the client page and the operator's
 * client page draw it: progress, then each step with why it matters, who
 * marked it and when, and a note or link.
 *
 * One form per step. The three buttons submit the same action with a
 * different `intent`, so a client marking a step done, marking it not done
 * or saving a link all go through one path. The `hidden` fields are whatever
 * the action needs to find the site — the client action needs the site, the
 * operator's needs the client too — and are supplied by the page, so this
 * component does not know which side it is on.
 */

export type ListingAction = (previous: MarkResult | null, formData: FormData) => Promise<MarkResult>;

export function ListingChecklist({
  checklist,
  action,
  hidden,
  readOnly,
  /** "you" on the client's page; the operator sees names. */
  viewerUserId,
}: {
  checklist: SiteChecklist;
  action: ListingAction;
  hidden: Record<string, string>;
  readOnly: boolean;
  viewerUserId: string;
}) {
  return (
    <ol className="listing-steps">
      {checklist.steps.map((step, index) => (
        <ListingStep
          key={step.key}
          n={index + 1}
          step={step}
          action={action}
          hidden={{ ...hidden, sitePublicId: checklist.sitePublicId, stepKey: step.key }}
          readOnly={readOnly}
          viewerUserId={viewerUserId}
        />
      ))}
    </ol>
  );
}

function markerLabel(step: ListingStepView, viewerUserId: string): string | null {
  if (!step.markedAt || !step.markedBy) return null;
  const who = step.markedBy.userId === viewerUserId ? "you" : step.markedBy.role === "admin" ? "Mortensen Web" : step.markedBy.name;
  const when = new Date(step.markedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${step.done ? "Done" : "Marked not done"} by ${who}, ${when}`;
}

function ListingStep({
  n,
  step,
  action,
  hidden,
  readOnly,
  viewerUserId,
}: {
  n: number;
  step: ListingStepView;
  action: ListingAction;
  hidden: Record<string, string>;
  readOnly: boolean;
  viewerUserId: string;
}) {
  const [state, formAction, pending] = useActionState<MarkResult | null, FormData>(action, null);
  const marker = markerLabel(step, viewerUserId);
  const noteId = `note-${hidden.sitePublicId}-${step.key}`;

  return (
    <li className={`listing-step${step.done ? " listing-step--done" : ""}`}>
      <span className="listing-step-mark" aria-hidden="true">
        {step.done ? "✓" : n}
      </span>
      <div className="listing-step-body">
        <strong>
          {step.title}
          <span className="visually-hidden">{step.done ? " (done)" : " (not done)"}</span>
        </strong>
        <p className="listing-step-why">{step.why}</p>
        <p className="listing-step-meta">
          {marker ?? "Not done yet"}
          {" · "}
          <a href={step.url} target="_blank" rel="noopener noreferrer">
            Where to do it
          </a>
        </p>
        {step.note && (
          <p className="listing-step-note">
            {/^https?:\/\//i.test(step.note) ? (
              <a href={step.note} target="_blank" rel="noopener noreferrer">
                {step.note}
              </a>
            ) : (
              step.note
            )}
          </p>
        )}

        {!readOnly && (
          <form action={formAction} className="listing-step-form">
            {Object.entries(hidden).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <label htmlFor={noteId} className="visually-hidden">
              Note or link for {step.title}
            </label>
            <input
              id={noteId}
              name="note"
              type="text"
              defaultValue={step.note ?? ""}
              placeholder="Note or link (optional)"
              maxLength={MAX_LISTING_NOTE_CHARS}
            />
            <div className="listing-step-actions">
              <button type="submit" name="intent" value={step.done ? "todo" : "done"} className={step.done ? "secondary small" : "small"} disabled={pending}>
                {pending ? "Saving…" : step.done ? "Mark not done" : "Mark done"}
              </button>
              <button type="submit" name="intent" value="note" className="secondary small" disabled={pending}>
                Save note
              </button>
            </div>
            {state && (
              <p className={state.ok ? "listing-step-saved" : "error"} role="status">
                {state.message}
              </p>
            )}
          </form>
        )}
      </div>
    </li>
  );
}
