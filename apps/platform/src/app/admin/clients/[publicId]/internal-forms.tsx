"use client";

import { useActionState } from "react";
import { designateInternalAction, type InternalResult } from "./internal-actions";

/**
 * Which client record is the agency's own site.
 *
 * The MortensenWeb tab shows exactly one record, flagged internal, and keeps it
 * out of Clients and every billing total. This moves that flag to the record
 * being viewed — for when the agency's site was added as an ordinary client and
 * that is where its repository, analytics and history now live.
 */
export function InternalPanel({
  clientPublicId,
  isInternal,
}: {
  clientPublicId: string;
  isInternal: boolean;
}) {
  const [state, action, pending] = useActionState<InternalResult | null, FormData>(
    designateInternalAction,
    null,
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>The agency&rsquo;s own site</h2>
        {isInternal && <span className="muted">MortensenWeb tab</span>}
      </div>

      {isInternal ? (
        <p style={{ margin: 0 }}>
          This is the agency&rsquo;s own site. It is shown under the MortensenWeb
          tab, and left out of Clients and every billing total.
        </p>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            If this record is your own site rather than a client, make it the
            MortensenWeb tab. Its site, repository, analytics and history stay as
            they are; it leaves the Clients list and billing totals, and the record
            the tab showed before is archived.
          </p>

          {state && !state.ok && <p className="error">{state.message}</p>}

          <form action={action}>
            <input type="hidden" name="clientPublicId" value={clientPublicId} />
            <button type="submit" className="secondary" disabled={pending}>
              {pending ? "Moving…" : "Make this the MortensenWeb tab"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
