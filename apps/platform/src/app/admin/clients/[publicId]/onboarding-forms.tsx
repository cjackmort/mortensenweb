"use client";

import { useActionState } from "react";
import { sendDemoInviteAction, setDemoUrlAction, type OnboardingResult } from "./onboarding-actions";

function Outcome({ state }: { state: OnboardingResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

/** The Netlify demo's address, saved on the client. */
export function DemoUrlForm({ clientPublicId, demoUrl }: { clientPublicId: string; demoUrl: string | null }) {
  const [state, action, pending] = useActionState<OnboardingResult | null, FormData>(setDemoUrlAction, null);
  return (
    <form action={action} className="onboarding-demo-url">
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <label htmlFor="demo-url">Demo URL</label>
      <div className="onboarding-row">
        <input
          id="demo-url"
          name="demoUrl"
          type="url"
          inputMode="url"
          placeholder="https://their-business-demo.netlify.app"
          defaultValue={demoUrl ?? ""}
        />
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

/**
 * "Email the demo link + ask for a call": the draft, editable, sent through
 * the portal's mailer. Folded away until wanted, and open when it is the next
 * step.
 */
export function DemoInviteForm({
  clientPublicId,
  draft,
  open,
  sentBefore,
}: {
  clientPublicId: string;
  draft: { to: string; subject: string; body: string };
  open: boolean;
  sentBefore: boolean;
}) {
  const [state, action, pending] = useActionState<OnboardingResult | null, FormData>(sendDemoInviteAction, null);
  return (
    <details className="onboarding-invite" open={open}>
      <summary>{sentBefore ? "Email the demo link again" : "Email the demo link + ask for a call"}</summary>
      <form action={action}>
        <input type="hidden" name="clientPublicId" value={clientPublicId} />
        <label htmlFor="invite-to">To</label>
        <input id="invite-to" name="to" type="email" defaultValue={draft.to} required />
        <label htmlFor="invite-subject">Subject</label>
        <input id="invite-subject" name="subject" defaultValue={draft.subject} required />
        <label htmlFor="invite-body">Message</label>
        <textarea id="invite-body" name="body" rows={11} defaultValue={draft.body} required />
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send email"}
        </button>
        <Outcome state={state} />
      </form>
    </details>
  );
}
