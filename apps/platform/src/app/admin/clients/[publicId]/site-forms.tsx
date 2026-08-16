"use client";

import { useActionState } from "react";
import {
  addSiteAction,
  connectAnalyticsAction,
  type SiteActionResult,
} from "./site-actions";

/**
 * Site and analytics forms.
 *
 * Client components only so validation errors render inline instead of via a
 * query string. Nothing secret passes through here — the Umami *website id* is
 * a public identifier that appears in the tracking snippet on the client's own
 * pages. The API key, which is secret, never leaves the server and has no field
 * anywhere in this UI.
 */

export function AddSiteForm({
  clientPublicId,
  suggestedName,
}: {
  clientPublicId: string;
  suggestedName: string;
}) {
  const [state, formAction, pending] = useActionState<
    SiteActionResult | null,
    FormData
  >(addSiteAction, null);

  return (
    <form action={formAction}>
      {state && !state.ok && <p className="error">{state.message}</p>}

      <input type="hidden" name="clientPublicId" value={clientPublicId} />

      <label htmlFor="siteName">Site name</label>
      <input
        id="siteName"
        name="siteName"
        type="text"
        defaultValue={suggestedName}
        required
        minLength={2}
      />

      <label htmlFor="primaryDomain">Domain</label>
      <input
        id="primaryDomain"
        name="primaryDomain"
        type="text"
        placeholder="example.com"
        autoCapitalize="none"
        spellCheck={false}
      />
      <p className="field-hint">
        Paste the full URL if easier — it&rsquo;s reduced to the hostname.
      </p>

      <button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add this site"}
      </button>
    </form>
  );
}

export function ConnectAnalyticsForm({
  clientPublicId,
  sitePublicId,
  currentWebsiteId,
}: {
  clientPublicId: string;
  sitePublicId: string;
  currentWebsiteId: string | null;
}) {
  const [state, formAction, pending] = useActionState<
    SiteActionResult | null,
    FormData
  >(connectAnalyticsAction, null);

  return (
    <form action={formAction}>
      {state && !state.ok && <p className="error">{state.message}</p>}
      {state?.ok && (
        <p className="notice notice-success">
          Saved. The client&rsquo;s Visitors page will show real figures once
          the tracking snippet is live on the site and someone has visited it.
        </p>
      )}

      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input type="hidden" name="sitePublicId" value={sitePublicId} />

      <label htmlFor={`umami-${sitePublicId}`}>Umami website ID</label>
      <input
        id={`umami-${sitePublicId}`}
        name="umamiWebsiteId"
        type="text"
        defaultValue={currentWebsiteId ?? ""}
        placeholder="0b1c2d3e-4f56-7890-abcd-ef1234567890"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="field-hint">
        From Umami: <strong>Websites → the site → Edit</strong>. It is the
        <code> data-website-id</code> in the tracking snippet, not the API key.
        Leave blank to disconnect.
      </p>

      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Saving…" : currentWebsiteId ? "Update connection" : "Connect analytics"}
      </button>
    </form>
  );
}
