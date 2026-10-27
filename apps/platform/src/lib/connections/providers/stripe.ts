import type Stripe from "stripe";
import { stripeClient } from "@/lib/payments/stripe";
import {
  formatMoney,
  percent,
  ProviderError,
  type AuditOutcome,
  type Finding,
  type ProviderGrant,
} from "../types";

/**
 * Stripe, read-only, through Connect's OAuth.
 *
 * The client authorises the platform to *read* their account (`read_only`);
 * every call after that is made with the platform key and a `Stripe-Account`
 * header, so no token of theirs is stored at all. The audit looks at the last
 * 30 days of charges, refunds, disputes and failed attempts, and at the
 * account itself: whether payouts are on, whether Stripe is waiting on them,
 * what shows on a customer's statement.
 */

export const STRIPE_SCOPE = "read_only";
const AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
/** Objects read per list. Enough for a local business's month; a cap, not a sample. */
const LIST_LIMIT = 500;

export type StripeConnectConfig = { ok: true; clientId: string } | { ok: false; missing: string[] };

export function stripeConnectConfig(env: Record<string, string | undefined> = process.env): StripeConnectConfig {
  const clientId = env.STRIPE_CONNECT_CLIENT_ID?.trim() ?? "";
  const missing = [!clientId && "STRIPE_CONNECT_CLIENT_ID", !env.STRIPE_SECRET_KEY && "STRIPE_SECRET_KEY"].filter(
    (name): name is string => Boolean(name),
  );
  return missing.length > 0 ? { ok: false, missing } : { ok: true, clientId };
}

export function stripeAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    scope: STRIPE_SCOPE,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function client(deps: { stripe?: Stripe }): Stripe {
  const stripe = deps.stripe ?? stripeClient();
  if (!stripe) throw new ProviderError("unavailable", "Stripe is not configured.");
  return stripe;
}

export async function exchangeStripeCode(code: string, deps: { stripe?: Stripe } = {}): Promise<ProviderGrant> {
  const stripe = client(deps);
  let token: Stripe.OAuthToken;
  try {
    token = await stripe.oauth.token({ grant_type: "authorization_code", code });
  } catch (error) {
    throw new ProviderError("auth", error instanceof Error ? error.message : "Stripe refused the code.");
  }
  const accountId = token.stripe_user_id;
  if (!accountId) throw new ProviderError("auth", "Stripe returned no account.");

  const account = await stripe.accounts.retrieve(accountId);
  return {
    externalId: accountId,
    displayName: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? accountId,
    scope: token.scope ?? STRIPE_SCOPE,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
  };
}

export async function deauthorizeStripe(
  accountId: string,
  clientId: string,
  deps: { stripe?: Stripe } = {},
): Promise<void> {
  await client(deps).oauth.deauthorize({ client_id: clientId, stripe_user_id: accountId });
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface StripeSnapshot {
  accountId: string;
  currency: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** Stripe's own field names for what it is waiting on, e.g. `individual.id_number`. */
  requirementsDue: string[];
  statementDescriptor: string | null;
  businessUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  /** Paid charges in the window. */
  charges: { count: number; grossCents: number };
  refunds: { count: number; cents: number };
  disputes: { count: number; cents: number };
  /** Attempts in the window: how many got through, how many were declined. */
  attempts: { succeeded: number; failed: number };
}

export async function fetchStripeSnapshot(
  accountId: string,
  window: { startAt: Date; endAt: Date },
  deps: { stripe?: Stripe } = {},
): Promise<StripeSnapshot> {
  const stripe = client(deps);
  const opts = { stripeAccount: accountId };
  const created = { gte: Math.floor(window.startAt.getTime() / 1000), lt: Math.floor(window.endAt.getTime() / 1000) };

  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(accountId);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    throw new ProviderError(
      status === 401 || status === 403 ? "auth" : "unavailable",
      error instanceof Error ? error.message : "Stripe could not be read.",
    );
  }

  const [charges, refunds, disputes, intents] = await Promise.all([
    stripe.charges.list({ created, limit: 100 }, opts).autoPagingToArray({ limit: LIST_LIMIT }),
    stripe.refunds.list({ created, limit: 100 }, opts).autoPagingToArray({ limit: LIST_LIMIT }),
    stripe.disputes.list({ created, limit: 100 }, opts).autoPagingToArray({ limit: LIST_LIMIT }),
    stripe.paymentIntents.list({ created, limit: 100 }, opts).autoPagingToArray({ limit: LIST_LIMIT }),
  ]);

  const paid = charges.filter((c) => c.paid && c.status === "succeeded");
  return {
    accountId,
    currency: account.default_currency ?? paid[0]?.currency ?? "usd",
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    requirementsDue: [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])],
    statementDescriptor: account.settings?.payments?.statement_descriptor ?? null,
    businessUrl: account.business_profile?.url ?? null,
    supportEmail: account.business_profile?.support_email ?? null,
    supportPhone: account.business_profile?.support_phone ?? null,
    charges: { count: paid.length, grossCents: paid.reduce((sum, c) => sum + c.amount, 0) },
    refunds: {
      count: refunds.filter((r) => r.status === "succeeded" || r.status === "pending").length,
      cents: refunds.filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((sum, r) => sum + r.amount, 0),
    },
    disputes: { count: disputes.length, cents: disputes.reduce((sum, d) => sum + d.amount, 0) },
    attempts: {
      succeeded: intents.filter((p) => p.status === "succeeded").length,
      failed: intents.filter((p) => p.last_payment_error != null && p.status !== "succeeded").length,
    },
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Above this share of takings refunded, something is going wrong before the sale. */
const REFUND_RATE_CONCERN = 5;
/** Declines are normal; above this share, and with enough attempts to mean it, they are a pattern. */
const FAILED_RATE_CONCERN = 15;
const MIN_ATTEMPTS_FOR_RATE = 5;

export function auditStripe(
  snapshot: StripeSnapshot,
  context: { siteHost: string | null; now: Date; startAt: Date; endAt: Date },
): AuditOutcome["audit"] {
  const findings: Finding[] = [];
  const money = (cents: number) => formatMoney(cents, snapshot.currency);

  if (snapshot.requirementsDue.length > 0) {
    findings.push({
      severity: "fix",
      title: "Stripe is waiting on information from you",
      detail: `Stripe lists ${snapshot.requirementsDue.length} item${snapshot.requirementsDue.length === 1 ? "" : "s"} it still needs before it will keep paying out. Open the Stripe dashboard and clear the notice at the top.`,
    });
  }
  if (!snapshot.payoutsEnabled) {
    findings.push({
      severity: "fix",
      title: "Payouts are switched off",
      detail: "Money taken is sitting in Stripe rather than reaching your bank. Check the bank account and identity details in Stripe's settings.",
    });
  }
  if (snapshot.disputes.count > 0) {
    findings.push({
      severity: "fix",
      title: `${snapshot.disputes.count} dispute${snapshot.disputes.count === 1 ? "" : "s"} this month`,
      detail: `${money(snapshot.disputes.cents)} is being contested by a customer's bank. Each one costs a fee whatever the outcome; answer it in Stripe with the receipt and any messages, and make sure your statement descriptor says who you are.`,
    });
  }

  const refundRate = percent(snapshot.refunds.cents, snapshot.charges.grossCents);
  if (snapshot.refunds.count >= 2 && refundRate > REFUND_RATE_CONCERN) {
    findings.push({
      severity: "improve",
      title: `${Math.round(refundRate)}% of takings were refunded`,
      detail: `${snapshot.refunds.count} refunds worth ${money(snapshot.refunds.cents)}. Above about ${REFUND_RATE_CONCERN}% usually means the price or what is included is not clear before people pay. Say it on the site and on the receipt.`,
    });
  }

  const attempts = snapshot.attempts.succeeded + snapshot.attempts.failed;
  const failedRate = percent(snapshot.attempts.failed, attempts);
  if (attempts >= MIN_ATTEMPTS_FOR_RATE && failedRate > FAILED_RATE_CONCERN) {
    findings.push({
      severity: "improve",
      title: `${Math.round(failedRate)}% of payment attempts failed`,
      detail: `${snapshot.attempts.failed} of ${attempts} attempts were declined. Some is normal; this much usually means the payment form is asking for the wrong thing or Stripe Radar is set too strictly. Check the declines in Stripe for the reason they give.`,
    });
  }

  if (!snapshot.statementDescriptor) {
    findings.push({
      severity: "improve",
      title: "No statement descriptor",
      detail: "Customers see an unfamiliar name on their bank statement and dispute it. Set your business name as the statement descriptor in Stripe's public details.",
    });
  }

  const businessHost = snapshot.businessUrl ? snapshot.businessUrl.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/.*$/, "").toLowerCase() : null;
  if (!businessHost) {
    findings.push({
      severity: "improve",
      title: "Stripe has no website for your business",
      detail: "Receipts and disputes go better when the customer can find you. Add your website under Stripe's public business details.",
    });
  } else if (context.siteHost && businessHost !== context.siteHost) {
    findings.push({
      severity: "improve",
      title: "Stripe's website is not your current site",
      detail: `Stripe shows ${businessHost}; your site is ${context.siteHost}. Update it under Stripe's public business details so receipts point to the right place.`,
    });
  }

  if (!snapshot.supportEmail && !snapshot.supportPhone) {
    findings.push({
      severity: "improve",
      title: "No support contact on receipts",
      detail: "A customer with a question about a charge has nowhere to turn but their bank. Add a support email or phone in Stripe's public details.",
    });
  }

  if (snapshot.charges.count === 0) {
    findings.push({
      severity: "improve",
      title: "Nothing was paid through Stripe in the last 30 days",
      detail: snapshot.chargesEnabled
        ? "If you are taking payment another way, that is fine. If customers should be paying online, check that the payment links on the site still work."
        : "Charges are not enabled on this account yet, so it cannot take a payment. Finish Stripe's setup.",
    });
  }

  if (findings.every((f) => f.severity !== "fix") && snapshot.charges.count > 0) {
    findings.push({
      severity: "good",
      title: "Payments look healthy",
      detail: `${snapshot.charges.count} payment${snapshot.charges.count === 1 ? "" : "s"} taken, ${money(snapshot.charges.grossCents)} in all, with ${snapshot.disputes.count === 0 ? "no disputes" : "disputes being handled"}.`,
    });
  }

  return {
    version: 1,
    at: context.now.toISOString(),
    startAt: context.startAt.toISOString(),
    endAt: context.endAt.toISOString(),
    headline: `${money(snapshot.charges.grossCents)} taken in ${snapshot.charges.count} payment${snapshot.charges.count === 1 ? "" : "s"}`,
    rows: [
      { label: "Taken", value: money(snapshot.charges.grossCents) },
      { label: "Payments", value: String(snapshot.charges.count) },
      { label: "Refunded", value: `${money(snapshot.refunds.cents)} (${snapshot.refunds.count})` },
      { label: "Disputes", value: String(snapshot.disputes.count) },
      { label: "Failed attempts", value: attempts > 0 ? `${snapshot.attempts.failed} of ${attempts}` : "none" },
      { label: "Payouts", value: snapshot.payoutsEnabled ? "on" : "off" },
    ],
    findings,
    snapshot: { ...snapshot },
  };
}
