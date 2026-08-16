"use client";

import { useActionState } from "react";
import {
  declarePaidAction,
  openedVenmoAction,
  type BillingActionResult,
} from "./actions";

/**
 * The pay flow.
 *
 * Two steps on purpose — see `actions.ts`. The Venmo link opens in a new tab
 * and records intent; the confirmation below it is a separate, explicit claim
 * that money was sent.
 *
 * The copy is careful about who does what. The client's tap does not settle the
 * invoice, and saying so plainly here avoids the situation where someone thinks
 * they are done, we think they are overdue, and a reminder goes out.
 */

export function PayPanel({
  requestPublicId,
  venmoUrl,
  reference,
  amount,
}: {
  requestPublicId: string;
  venmoUrl: string | null;
  reference: string;
  amount: string;
}) {
  const [openState, openAction] = useActionState<
    BillingActionResult | null,
    FormData
  >(openedVenmoAction, null);
  const [declareState, declareAction, declaring] = useActionState<
    BillingActionResult | null,
    FormData
  >(declarePaidAction, null);

  if (declareState?.ok) {
    return (
      <div className="notice notice-success" style={{ marginBottom: 0 }}>
        <strong>Thanks — we&rsquo;ll confirm it.</strong> You won&rsquo;t get
        any reminders about this while we check. If anything looks wrong
        we&rsquo;ll get in touch rather than chase you.
      </div>
    );
  }

  return (
    <>
      {declareState && !declareState.ok && (
        <p className="error">{declareState.message}</p>
      )}

      {venmoUrl ? (
        <form action={openAction}>
          <input type="hidden" name="requestPublicId" value={requestPublicId} />
          <button
            type="submit"
            formTarget="_blank"
            onClick={() => window.open(venmoUrl, "_blank", "noopener")}
          >
            Pay {amount} with Venmo
          </button>
        </form>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Venmo isn&rsquo;t set up yet — please get in touch and we&rsquo;ll
          sort out payment another way.
        </p>
      )}

      <p className="field-hint" style={{ margin: "0.75rem 0 1rem" }}>
        Include <strong>{reference}</strong> in the note so we can match your
        payment. Opening Venmo doesn&rsquo;t mark this as paid — tell us below
        once you&rsquo;ve actually sent it.
        {openState?.ok && " (We've noted that you opened Venmo.)"}
      </p>

      <form action={declareAction}>
        <input type="hidden" name="requestPublicId" value={requestPublicId} />
        <button type="submit" className="secondary" disabled={declaring}>
          {declaring ? "Recording…" : "I've sent the payment"}
        </button>
      </form>
    </>
  );
}
