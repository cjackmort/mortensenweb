/**
 * What to tell a client about their billing.
 *
 * Seven states, and the distinctions between them are the point. "Paid" and
 * "we have never charged you" are opposite facts that a naive implementation
 * renders identically — as an empty invoice list and a green tick — and a
 * client who is told they are paid up when nobody has ever billed them will
 * find out otherwise at the worst possible moment.
 *
 * The rule this encodes: a client is only ever described as paid on the
 * evidence of a settled invoice. Absence of evidence renders as
 * `not_subscribed`, never as success.
 */

export type BillingState =
  /** A settled invoice covers the current period. */
  | "paid"
  /** Payment submitted, not yet settled — a delayed method, or a webhook in flight. */
  | "processing"
  /** The last charge failed, or needs the cardholder to authenticate. */
  | "action_required"
  /** Cancelled, but still inside a period they paid for. Entitlements intact. */
  | "cancellation_scheduled"
  /** An operator granted this plan. Never charged, never chased. */
  | "complimentary"
  /** No subscription exists. The default, and what absence of data means. */
  | "not_subscribed";

export interface BillingStatusInput {
  compPlanId: string | null;
  /** Stripe's own status word, or null when there is no Stripe subscription. */
  providerStatus: string | null;
  cancelAtPeriodEnd: boolean;
  /** Paid-through. Null when nothing has ever settled. */
  currentPeriodEnd: Date | null;
  /** Whether any settled invoice that actually collected cash exists. */
  hasSettledInvoice: boolean;
}

export interface BillingStatus {
  state: BillingState;
  /** One line, in the client's terms. */
  label: string;
  detail: string;
  /** Whether the page should offer a "resolve this" route to Stripe. */
  needsAction: boolean;
}

export function billingStatusFor(input: BillingStatusInput): BillingStatus {
  // Checked before anything about payment, so a payment event can never
  // present a complimentary client as an ordinary payer.
  if (input.compPlanId) {
    return {
      state: "complimentary",
      label: "Complimentary",
      detail: "Your plan is on the house. There is nothing to pay.",
      needsAction: false,
    };
  }

  if (!input.providerStatus) {
    return {
      state: "not_subscribed",
      label: "Not subscribed",
      detail: "You do not have an automatic payment set up.",
      needsAction: false,
    };
  }

  switch (input.providerStatus) {
    case "past_due":
    case "unpaid":
      return {
        state: "action_required",
        label: "Payment failed",
        detail:
          "Your last payment did not go through. Your site stays online — update your card to clear it.",
        needsAction: true,
      };

    case "incomplete":
      return {
        state: "action_required",
        label: "Action needed",
        detail:
          "Your bank asked for confirmation before the first payment could complete.",
        needsAction: true,
      };

    case "incomplete_expired":
    case "canceled":
      return {
        state: "not_subscribed",
        label: "Not subscribed",
        detail: "This subscription has ended.",
        needsAction: false,
      };

    case "paused":
      return {
        state: "processing",
        label: "Paused",
        detail: "Billing is paused on this subscription.",
        needsAction: false,
      };

    case "trialing":
    case "active": {
      if (input.cancelAtPeriodEnd) {
        return {
          state: "cancellation_scheduled",
          label: "Cancels at period end",
          detail:
            "You keep everything you have paid for until the end of this period.",
          needsAction: false,
        };
      }

      // An active subscription whose first invoice has not settled is not paid
      // — this is the delayed-payment and webhook-in-flight window, and
      // calling it "paid" here is exactly the error this module exists to
      // prevent.
      if (!input.hasSettledInvoice) {
        return {
          state: "processing",
          label: "Payment processing",
          detail:
            "We have your authorisation. This will show as paid once the payment settles.",
          needsAction: false,
        };
      }

      return {
        state: "paid",
        label: "Paid",
        detail: "Your subscription is active and paid up.",
        needsAction: false,
      };
    }

    default:
      // An unrecognised status is never optimistically reported as paid.
      return {
        state: "processing",
        label: "Processing",
        detail: "We are confirming the status of your subscription.",
        needsAction: false,
      };
  }
}
