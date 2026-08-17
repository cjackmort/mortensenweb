"use client";

import { useActionState } from "react";
import {
  dispatchBriefAction,
  saveBriefAction,
  type BriefResult,
} from "./brief-actions";

/**
 * What the client asked for, typed during or straight after the call.
 *
 * Laid out as four labelled boxes rather than one, because the labels are doing
 * work at the far end: the agent receives them as headings and treats colour
 * direction differently from a list of wanted pages. One undifferentiated blob
 * would have to be re-read and guessed at.
 *
 * None of the fields is individually required — an operator who has one line
 * about the colour scheme and nothing else should be able to save that. The
 * only rule is that *something* is filled in, which the server enforces.
 */

interface SiteOption {
  publicId: string;
  name: string;
}

export function BriefForm({
  clientPublicId,
  sites,
  hasSite,
}: {
  clientPublicId: string;
  sites: SiteOption[];
  hasSite: boolean;
}) {
  const [state, formAction, pending] = useActionState<BriefResult | null, FormData>(
    saveBriefAction,
    null,
  );

  return (
    <form action={formAction}>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"}>
          {state.message}
          {state.ok && state.issueUrl && (
            <>
              {" "}
              <a href={state.issueUrl} target="_blank" rel="noopener noreferrer">
                View the work
              </a>
              .
            </>
          )}
        </p>
      )}

      <input type="hidden" name="clientPublicId" value={clientPublicId} />

      {sites.length > 1 ? (
        <>
          <label htmlFor="briefSite">Which site?</label>
          <select id="briefSite" name="sitePublicId">
            {sites.map((site) => (
              <option key={site.publicId} value={site.publicId}>
                {site.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        sites[0] && (
          <input type="hidden" name="sitePublicId" value={sites[0].publicId} />
        )
      )}

      <label htmlFor="briefKind">What kind of brief?</label>
      <select id="briefKind" name="kind" defaultValue="discovery">
        <option value="discovery">First build — this is a new site</option>
        <option value="revision">Revisions to a site that exists</option>
      </select>

      <label htmlFor="colourDirection">Colours and look</label>
      <textarea
        id="colourDirection"
        name="colourDirection"
        rows={3}
        placeholder="Wants the deep green from their truck wrap. Dislikes the blue on the current site. Clean, not fussy."
      />

      <label htmlFor="features">Pages and features they want</label>
      <textarea
        id="features"
        name="features"
        rows={4}
        placeholder="Home, services, gallery, contact. Wants a quote request form. Asked about showing service areas on a map."
      />

      <label htmlFor="contentNotes">Content notes</label>
      <textarea
        id="contentNotes"
        name="contentNotes"
        rows={4}
        placeholder="Emphasise 24-hour emergency callouts. Family business since 1998. Will send photos of the crew next week."
      />
      {/* The anti-fabrication rule, stated where it is actually relevant: at
          the point someone might type an unverified claim into the box. */}
      <p className="field-hint">
        Only write down details you have confirmed. Anything uncertain — licence
        numbers, prices, guarantees, review quotes — is better left out; the
        agent will use a placeholder and flag it rather than inventing something.
      </p>

      <label htmlFor="briefBody">Anything else</label>
      <textarea
        id="briefBody"
        name="body"
        rows={3}
        placeholder="Whatever didn't fit above."
      />

      <div className="actions">
        <button type="submit" name="intent" value="build" disabled={pending || !hasSite}>
          {pending ? "Working…" : "Save and build"}
        </button>
        <button
          type="submit"
          name="intent"
          value="save"
          className="secondary"
          disabled={pending}
        >
          Save as draft
        </button>
      </div>

      {!hasSite && (
        <p className="field-hint">
          Add a site with a connected repository before building — there is
          nowhere for the changes to go yet.
        </p>
      )}
    </form>
  );
}

/** Send a previously saved draft to the agent. */
export function DispatchBriefForm({
  briefPublicId,
  clientPublicId,
}: {
  briefPublicId: string;
  clientPublicId: string;
}) {
  const [state, formAction, pending] = useActionState<BriefResult | null, FormData>(
    dispatchBriefAction,
    null,
  );

  return (
    <form action={formAction}>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"}>
          {state.message}
        </p>
      )}
      <input type="hidden" name="briefPublicId" value={briefPublicId} />
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Sending…" : "Send this to the agent"}
      </button>
    </form>
  );
}
