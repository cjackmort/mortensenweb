"use client";

import { useActionState, useEffect } from "react";
import {
  declarePaidAction,
  openedVenmoAction,
  type BillingActionResult,
} from "./actions";
import { startCheckoutAction, type CheckoutResult } from "./checkout-actions";

/**
 * The pay flow.
 *
 * Card first, Venmo second — and the ordering is doing real work. A card
 * payment confirms itself through a webhook in seconds; a Venmo transfer needs
 * a human to notice and confirm, which is slower for the client and manual for
 * us. Presenting them as equals would send people down the worse path out of
 * familiarity.
 *
 * The Venmo half stays two steps on purpose — see `actions.ts`. The link
 * records intent; the confirmation below it is a separate, explicit claim that
 * money was sent. That copy is careful about who does what, because the
 * alternative is someone thinking they are done, us thinking they are overdue,
 * and a reminder going out.
 */

export function PayPanel({
  requestPublicId,
  venmoUrl,
  reference,
  amount,
  cardAvailable,
}: {
  requestPublicId: string;
  venmoUrl: string | null;
  reference: string;
  amount: string;
  /** False when Square has no credentials in this environment. */
  cardAvailable: boolean;
}) {
  const [openState, openAction] = useActionState<
    BillingActionResult | null,
    FormData
  >(openedVenmoAction, null);
  const [declareState, declareAction, declaring] = useActionState<
    BillingActionResult | null,
    FormData
  >(declarePaidAction, null);
  const [cardState, cardAction, cardPending] = useActionState<
    CheckoutResult | null,
    FormData
  >(startCheckoutAction, null);

  // Redirect from the client so a Square failure leaves them here with an
  // explanation rather than on a broken page.
  useEffect(() => {
    if (cardState?.ok) window.location.replace(cardState.url);
  }, [cardState]);

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

      {cardState && !cardState.ok && (
        <p className="error">{cardState.message}</p>
      )}

      {cardAvailable && (
        <>
          <form action={cardAction}>
            <input type="hidden" name="recurring" value="false" />
            <button type="submit" disabled={cardPending}>
              {cardPending ? "Starting…" : `Pay ${amount} by card`}
            </button>
          </form>
          <p className="field-hint" style={{ margin: "0.75rem 0 1.25rem" }}>
            Handled by Square, and confirmed automatically &mdash; nothing else
            to do afterwards. We never see your card details.
          </p>
        </>
      )}

      {venmoUrl ? (
        <form action={openAction}>
          <input type="hidden" name="requestPublicId" value={requestPublicId} />
          <button
            type="submit"
            // Secondary once a card option exists: still entirely available,
            // just not the path we steer someone to by default.
            className={cardAvailable ? "secondary" : undefined}
            formTarget="_blank"
            onClick={() => window.open(venmoUrl, "_blank", "noopener")}
          >
            {cardAvailable ? "Pay with Venmo instead" : `Pay ${amount} with Venmo`}
          </button>
        </form>
      ) : (
        !cardAvailable && (
          <p className="muted" style={{ margin: 0 }}>
            Payment isn&rsquo;t set up yet — please get in touch and we&rsquo;ll
            sort it out another way.
          </p>
        )
      )}

      {venmoUrl && (
        <>
          <p className="field-hint" style={{ margin: "0.75rem 0 1rem" }}>
            Include <strong>{reference}</strong> in the note so we can match your
            payment. Opening Venmo doesn&rsquo;t mark this as paid — tell us
            below once you&rsquo;ve actually sent it.
            {openState?.ok && " (We've noted that you opened Venmo.)"}
          </p>

          <form action={declareAction}>
            <input
              type="hidden"
              name="requestPublicId"
              value={requestPublicId}
            />
            <button type="submit" className="secondary" disabled={declaring}>
              {declaring ? "Recording…" : "I've sent the payment"}
            </button>
          </form>
        </>
      )}
    </>
  );
}
