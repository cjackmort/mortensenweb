"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import type { BillingState } from "@/lib/billing/stripe-status";
import type { StripePaymentRow } from "@/db/repositories/client/stripe-billing";
import {
  openBillingPortalAction,
  startStripeSubscriptionAction,
  type StripeCheckoutResult,
} from "./stripe-actions";

/**
 * Automatic card payments.
 *
 * The states are kept visibly distinct because they mean different things and
 * are routinely collapsed into a green tick and a red cross:
 *
 *  - "processing" is not "paid". A client whose first payment is still
 *    settling has authorised nothing that has arrived yet.
 *  - "payment failed" is not "your site is going away". It says so explicitly,
 *    because that is the thing a small business owner assumes.
 *  - "cancels at period end" is not "not subscribed". They keep everything
 *    they paid for.
 *  - "complimentary" is not a payment state at all.
 *
 * Nothing here decides access. It renders what the server derived from settled
 * invoices; the URL the client came back on is not consulted.
 */

const TONE: Record<BillingState, string> = {
  paid: "ok",
  processing: "pending",
  action_required: "warn",
  cancellation_scheduled: "pending",
  complimentary: "ok",
  not_subscribed: "muted",
};

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(cents / 100);
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(`${value}T00:00:00`) : value;
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function StripePanel({
  state,
  label,
  detail,
  needsAction,
  planName,
  monthlyPriceCents,
  currency,
  paidThrough,
  nextChargeOn,
  nextChargeCents,
  history,
  canManage,
  offerPlanKey,
}: {
  state: BillingState;
  label: string;
  detail: string;
  needsAction: boolean;
  planName: string | null;
  monthlyPriceCents: number | null;
  currency: string;
  paidThrough: string | null;
  nextChargeOn: string | null;
  nextChargeCents: number | null;
  history: StripePaymentRow[];
  canManage: boolean;
  /** The plan to offer when they are not subscribed. Null hides the offer. */
  offerPlanKey: string | null;
}) {
  const [checkout, checkoutAction, starting] = useActionState<
    StripeCheckoutResult | null,
    FormData
  >(startStripeSubscriptionAction, null);

  const [portalPending, startPortal] = useTransition();
  const [portalError, setPortalError] = useState<string | null>(null);

  // Stripe returns a URL rather than the server redirecting, so a failure
  // leaves the client on this page with an explanation instead of stranded on
  // an error with no way back.
  //
  // In an effect, not during render: navigating is a side effect, and React
  // may render this more than once per action result — which in the render
  // body would fire the navigation repeatedly.
  useEffect(() => {
    if (checkout?.ok) window.location.href = checkout.url;
  }, [checkout]);

  function openPortal() {
    setPortalError(null);
    startPortal(async () => {
      const result = await openBillingPortalAction();
      if (result.ok) window.location.href = result.url;
      else setPortalError(result.message);
    });
  }

  return (
    <section className="panel" aria-labelledby="stripe-heading">
      <div className="masthead">
        <h2 id="stripe-heading">Automatic payments</h2>
        <span className={`badge badge--${TONE[state]}`}>{label}</span>
      </div>

      <p>{detail}</p>

      {state !== "not_subscribed" && state !== "complimentary" ? (
        <dl className="facts">
          {planName ? (
            <>
              <dt>Plan</dt>
              <dd>{planName}</dd>
            </>
          ) : null}

          {monthlyPriceCents !== null ? (
            <>
              <dt>Recurring</dt>
              <dd>{formatMoney(monthlyPriceCents, currency)} a month</dd>
            </>
          ) : null}

          {/* Only shown once something has actually settled. An empty
              paid-through beside an active subscription would read as paid. */}
          {paidThrough ? (
            <>
              <dt>Paid through</dt>
              <dd>{formatDate(paidThrough)}</dd>
            </>
          ) : null}

          {nextChargeOn && nextChargeCents !== null ? (
            <>
              <dt>Next payment</dt>
              <dd>
                {formatMoney(nextChargeCents, currency)} on{" "}
                {formatDate(nextChargeOn)}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {needsAction ? (
        <p className="notice notice--warn">
          Your website stays online. Update your card to clear the outstanding
          payment.
        </p>
      ) : null}

      {state === "not_subscribed" && offerPlanKey ? (
        <form action={checkoutAction}>
          {/* The plan key only. No price, no amount, no customer id — the
              server resolves all three, and would ignore them if sent. */}
          <input type="hidden" name="planKey" value={offerPlanKey} />
          <button type="submit" disabled={starting}>
            {starting ? "Starting…" : "Set up automatic payment"}
          </button>
          <p className="hint">
            You&rsquo;ll authorise the recurring payment on Stripe&rsquo;s own
            checkout page, and can cancel it any time.
          </p>
        </form>
      ) : null}

      {checkout && !checkout.ok ? (
        <p className="notice notice--warn">{checkout.message}</p>
      ) : null}

      {canManage ? (
        <p>
          <button type="button" onClick={openPortal} disabled={portalPending}>
            {portalPending ? "Opening…" : "Manage billing"}
          </button>
          <span className="hint">
            {" "}
            Update your card, or see every invoice.
          </span>
        </p>
      ) : null}

      {portalError ? (
        <p className="notice notice--warn">{portalError}</p>
      ) : null}

      {history.length > 0 ? (
        <>
          <h3>Payment history</h3>
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Amount</th>
                <th scope="col">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.publicId}>
                  <td>{formatDate(row.receivedOn)}</td>
                  <td>
                    {formatMoney(row.amountCents, row.currency)}
                    {/* A settlement that collected nothing is labelled, not
                        hidden — it is in the ledger and the client may see it
                        referenced elsewhere. */}
                    {!row.collectedCash ? (
                      <span className="hint"> (no charge)</span>
                    ) : null}
                  </td>
                  <td>
                    {row.receiptUrl ? (
                      <a
                        href={row.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
