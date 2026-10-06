"use client";

import { useActionState } from "react";
import { connectFormsInboxAction, type FormsInboxResult } from "./site-actions";

/**
 * The leads inbox for one site: whether its contact forms reach the client's
 * Growth tab, and the button that makes them.
 */
export function FormsInboxPanel({
  clientPublicId,
  sitePublicId,
  connectedAt,
  hasHosting,
}: {
  clientPublicId: string;
  sitePublicId: string;
  /** Already formatted on the server, so the browser cannot render it differently. */
  connectedAt: string | null;
  hasHosting: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormsInboxResult | null, FormData>(
    connectFormsInboxAction,
    null,
  );

  return (
    <form action={formAction}>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"}>{state.message}</p>
      )}
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input type="hidden" name="sitePublicId" value={sitePublicId} />

      <p className="muted" style={{ marginTop: 0 }}>
        {connectedAt
          ? `Connected ${connectedAt}. Contact-form submissions arrive in the client's Growth tab and they are emailed for each one.`
          : "Not connected. The site's form still works, but enquiries only reach Netlify and its notification email."}
      </p>
      <p className="field-hint">
        Connecting registers a signed Netlify webhook and imports the enquiries
        Netlify already holds, without emailing about them. Afterwards, turn off
        any email notification set up for this form in Netlify, or the client
        will get two emails per enquiry. The site&rsquo;s form needs Netlify
        form detection enabled.
      </p>

      <button type="submit" className={connectedAt ? "secondary" : ""} disabled={pending || !hasHosting}>
        {pending ? "Connecting…" : connectedAt ? "Reconnect and re-import" : "Connect leads inbox"}
      </button>
      {!hasHosting && <p className="hint">Set up hosting for this site first.</p>}
    </form>
  );
}
