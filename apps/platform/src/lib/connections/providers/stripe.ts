import Stripe from "stripe";
import { STRIPE_API_VERSION } from "@/lib/payments/stripe";
import {
  formatMoney,
  percent,
  ProviderError,
  type AuditOutcome,
  type Finding,
  type ProviderGrant,
} from "../types";

/**
 * Stripe, read-only, by a restricted key the client makes for us.
 *
 * Connect's OAuth looked like the way in, but Stripe allows its `read_only`
 * scope only for its retired extensions: a platform may ask for
 * `read_write`, which is full control of the client's account, and nothing
 * less. A restricted key set to Read on the five things the audit uses is
 * how a client lets us look without letting us touch. It is sealed like any
 * other token, and every call is made with it against the client's own
 * account, so the platform's Connect settings play no part.
 *
 * The audit looks at the last 30 days of charges, refunds, disputes and
 * failed attempts, and at the account itself: whether payouts are on,
 * whether Stripe is waiting on them, what shows on a customer's statement.
 */

export const STRIPE_KEY_SCOPE = "restricted_key";
/** Objects read per list. Enough for a local business's month; a cap, not a sample. */
const LIST_LIMIT = 500;
/** Real keys run to about a hundred characters; anything this short was cut off. */
const MIN_KEY_BODY = 8;
const RESTRICTED_KEY = new RegExp(`^rk_(live|test)_[A-Za-z0-9]{${MIN_KEY_BODY},}$`);
/** Any Stripe key, wherever one turns up in a message about to be stored or logged. */
const ANY_KEY = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9*]+/g;

/** What the audit reads, named as Stripe's restricted-key form names them. */
const READS = [
  { label: "Accounts", probe: (stripe: Stripe) => stripe.accounts.retrieveCurrent() },
  { label: "Charges", probe: (stripe: Stripe) => stripe.charges.list({ limit: 1 }) },
  { label: "Refunds", probe: (stripe: Stripe) => stripe.refunds.list({ limit: 1 }) },
  { label: "Disputes", probe: (stripe: Stripe) => stripe.disputes.list({ limit: 1 }) },
  { label: "PaymentIntents", probe: (stripe: Stripe) => stripe.paymentIntents.list({ limit: 1 }) },
] as const;

export const STRIPE_KEY_READS: readonly string[] = READS.map((read) => read.label);

export type StripeKeyCheck = { ok: true; key: string } | { ok: false; message: string };

/**
 * Is what was pasted a key we should keep? Only a restricted one: the
 * secret key can do anything and is refused before it goes anywhere, and a
 * test key on the live portal would read "nothing paid" every month.
 */
export function checkStripeKey(raw: string, opts: { production?: boolean } = {}): StripeKeyCheck {
  const production = opts.production ?? process.env.NODE_ENV === "production";
  const key = raw.trim();
  if (!key) return { ok: false, message: "Paste the key Stripe showed you. It starts rk_live_." };
  if (/^sk_(live|test)_/.test(key)) {
    return {
      ok: false,
      message:
        "That is your secret key, which can do anything in your Stripe account. We didn't keep it. Make a restricted key instead: it starts rk_live_.",
    };
  }
  if (/^pk_(live|test)_/.test(key)) {
    return { ok: false, message: "That is your publishable key, which can't read anything. Make a restricted key: it starts rk_live_." };
  }
  const match = RESTRICTED_KEY.exec(key);
  if (!match) return { ok: false, message: "That doesn't look like a Stripe restricted key. It starts rk_live_ and has no spaces." };
  if (match[1] === "test" && production) {
    return {
      ok: false,
      message: "That is a test key, so it would only ever show test payments. Make the key with Stripe in live mode: it starts rk_live_.",
    };
  }
  return { ok: true, key };
}

export function stripeForKey(key: string): Stripe {
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    appInfo: { name: "mortensenweb-portal", version: "1.0.0" },
  });
}

function redactKeys(text: string): string {
  return text.replace(ANY_KEY, "[key]");
}

type StripeFailure = { kind: "auth" | "permission" | "unavailable"; message: string };

function stripeFailure(error: unknown): StripeFailure {
  const { type, statusCode } = error as { type?: string; statusCode?: number };
  const message = redactKeys(error instanceof Error ? error.message : "Stripe could not be read.");
  if (type === "StripeAuthenticationError" || statusCode === 401) return { kind: "auth", message };
  if (type === "StripePermissionError" || statusCode === 403) return { kind: "permission", message };
  return { kind: "unavailable", message };
}

function listed(labels: string[]): string {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * Try each read the audit will make before keeping the key, so a key
 * missing a permission is turned away now, naming what to set, rather than
 * failing every night after.
 */
export async function acceptStripeKey(key: string, deps: { stripe?: Stripe } = {}): Promise<ProviderGrant> {
  const stripe = deps.stripe ?? stripeForKey(key);
  const results = await Promise.allSettled(READS.map(async (read) => read.probe(stripe)));
  const failed = results.flatMap((result, i) =>
    result.status === "rejected" ? [{ label: READS[i]!.label, ...stripeFailure(result.reason) }] : [],
  );

  if (failed.some((f) => f.kind === "auth")) {
    throw new ProviderError("invalid", "Stripe didn't accept that key. Check it was copied whole and hasn't been deleted.");
  }
  const missing = failed.filter((f) => f.kind === "permission").map((f) => f.label);
  if (missing.length > 0) {
    throw new ProviderError(
      "invalid",
      `That key can't read ${listed(missing)} yet. In Stripe, edit the key, set ${missing.length === 1 ? "it" : "each of them"} to Read, and paste it again.`,
    );
  }
  if (failed.length > 0) throw new ProviderError("unavailable", `Stripe couldn't be read: ${failed[0]!.message}`);

  const account = (results[0] as PromiseFulfilledResult<Stripe.Account>).value;
  return {
    externalId: account.id,
    displayName: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? null,
    scope: STRIPE_KEY_SCOPE,
    accessToken: key,
    refreshToken: null,
    expiresAt: null,
  };
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

/**
 * One read, with Stripe's refusal turned into what the row should do: a
 * deleted key or a lost permission asks the client to reconnect, anything
 * else is a passing outage. The key never reaches the message.
 */
async function reading<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const failure = stripeFailure(error);
    if (failure.kind === "auth") {
      throw new ProviderError("auth", "Stripe no longer accepts the key; it may have been deleted. Make a new one and connect again.");
    }
    if (failure.kind === "permission") {
      throw new ProviderError("auth", `The key can no longer read ${label}. Set it back to Read in Stripe, or make a new key and connect again.`);
    }
    throw new ProviderError("unavailable", failure.message);
  }
}

export async function fetchStripeSnapshot(
  window: { startAt: Date; endAt: Date },
  deps: { stripe: Stripe },
): Promise<StripeSnapshot> {
  const { stripe } = deps;
  const created = { gte: Math.floor(window.startAt.getTime() / 1000), lt: Math.floor(window.endAt.getTime() / 1000) };

  const [account, charges, refunds, disputes, intents] = await Promise.all([
    reading("Accounts", () => stripe.accounts.retrieveCurrent()),
    reading("Charges", () => stripe.charges.list({ created, limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT })),
    reading("Refunds", () => stripe.refunds.list({ created, limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT })),
    reading("Disputes", () => stripe.disputes.list({ created, limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT })),
    reading("PaymentIntents", () =>
      stripe.paymentIntents.list({ created, limit: 100 }).autoPagingToArray({ limit: LIST_LIMIT }),
    ),
  ]);

  const paid = charges.filter((c) => c.paid && c.status === "succeeded");
  return {
    accountId: account.id,
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
