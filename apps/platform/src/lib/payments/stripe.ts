import Stripe from "stripe";
import { PLANS, type PlanKey } from "@mortensenweb/plans";

/**
 * The Stripe client, and the one place that decides which price a plan buys.
 *
 * ## Why a pinned API version
 *
 * Stripe rolls the default API version forward per account. An integration
 * that does not pin one changes behaviour when somebody presses a button in a
 * dashboard, and the change arrives as differently-shaped webhook payloads
 * rather than as an error. Pinning here means the shape this code parses is
 * the shape it was written against, and moving to a newer version is a commit
 * with a diff rather than a surprise.
 *
 * The version below matches the one the installed SDK generates types from.
 * They must move together: a pinned version older than the SDK's types is how
 * you get code that compiles against fields the API does not send.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

/**
 * Plan key to price lookup key.
 *
 * Lookup keys rather than price ids, deliberately. A price id
 * (`price_1UDVgj…`) differs between the sandbox and the live account, so
 * hardcoding one means the same commit cannot run in both and the test
 * environment silently bills against a price that does not exist. A lookup key
 * is a string *we* choose and set identically in both accounts, so this table
 * is environment-independent and the code is the same everywhere.
 *
 * The `_v1` suffix exists because Stripe prices are immutable. Changing what a
 * plan costs means creating a new price and moving the lookup key, and a
 * version suffix makes "which price is current" answerable by reading this
 * file rather than by sorting the Stripe dashboard by creation date.
 *
 * `comp-unlimited` is absent on purpose. A complimentary client has no price
 * because they are never charged; giving them one would make it possible to
 * put a comp client through checkout, which is the exact mistake
 * `clients.comp_plan_id` exists to prevent.
 */
const PRICE_LOOKUP_KEYS: Record<PlanKey, string> = {
  "care-lite": "care_lite_monthly_v1",
  "care-basic": "care_basic_monthly_v1",
  "care-plus": "care_plus_monthly_v1",
  "care-unlimited": "care_unlimited_monthly_v1",
};

export function lookupKeyForPlan(key: PlanKey): string | null {
  return PRICE_LOOKUP_KEYS[key] ?? null;
}

/** Reverse direction, for reading a subscription back off Stripe. */
export function planForLookupKey(lookupKey: string): PlanKey | null {
  const found = Object.entries(PRICE_LOOKUP_KEYS).find(
    ([, value]) => value === lookupKey,
  );
  return (found?.[0] as PlanKey | undefined) ?? null;
}

/** Every lookup key this build knows about, for the reconciliation job. */
export function allLookupKeys(): string[] {
  return Object.values(PRICE_LOOKUP_KEYS);
}

export interface StripeMode {
  /** True when the configured secret key is a live key. */
  livemode: boolean;
}

/**
 * Which mode the configured key is in, decided by the key itself.
 *
 * Read from the key prefix rather than from a separate `STRIPE_ENVIRONMENT`
 * variable, because two sources for one fact can disagree — and the failure
 * when they do is that a deployment believing itself to be in test mode
 * charges real cards. The key is the only thing that actually decides, so it
 * is the only thing consulted.
 *
 * Restricted keys (`rk_`) carry the same `test`/`live` marker in the same
 * position, so they are handled by the same check.
 */
export function modeFromKey(secretKey: string): StripeMode {
  return { livemode: !/^(sk|rk)_test_/.test(secretKey) };
}

export class StripeNotConfigured extends Error {
  constructor() {
    super("Stripe is not configured.");
    this.name = "StripeNotConfigured";
  }
}

let cached: { key: string; client: Stripe } | null = null;

/**
 * The configured client, or null when Stripe is switched off.
 *
 * Null rather than a throw: Stripe being absent is a supported state. The
 * platform billed through Square and by hand before this existed and must keep
 * working when `STRIPE_SECRET_KEY` is unset — a portal that 500s on the
 * billing page because a processor is not configured is a worse outcome than
 * one that shows the Square path.
 */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;

  if (cached?.key === key) return cached.client;

  const client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    // Stripe's own retry logic, rather than ours. Its backoff is
    // idempotency-key aware, so a retried create cannot produce two objects.
    maxNetworkRetries: 2,
    appInfo: { name: "mortensenweb-portal", version: "1.0.0" },
  });

  cached = { key, client };
  return client;
}

/** Throwing accessor, for paths that have already checked configuration. */
export function requireStripe(): Stripe {
  const client = stripeClient();
  if (!client) throw new StripeNotConfigured();
  return client;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Whether an object from Stripe belongs to the mode we are configured for.
 *
 * Every Stripe object carries `livemode`. Checking it on arrival is what stops
 * a webhook from the live account being processed by a deployment holding test
 * keys — which would otherwise unlock a client against money that this
 * environment cannot see, and is not hypothetical once the same code runs in
 * two places.
 */
export function modeMatches(objectLivemode: boolean): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return false;
  return modeFromKey(key).livemode === objectLivemode;
}

/**
 * Resolve a plan to the live price object.
 *
 * Looked up by key on every call rather than memoised for the process
 * lifetime. A price that has been archived in the dashboard must stop being
 * sellable immediately, and a cache measured in hours is exactly long enough
 * to sell a plan at a price that was withdrawn.
 */
export async function priceForPlan(
  planKey: PlanKey,
): Promise<Stripe.Price | null> {
  const lookupKey = lookupKeyForPlan(planKey);
  if (!lookupKey) return null;

  const stripe = requireStripe();
  const found = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });

  return found.data[0] ?? null;
}

/**
 * What the portal believes a plan costs, from the shared plans package.
 *
 * Used to check Stripe against ourselves rather than to decide a charge — the
 * amount charged is always whatever the Stripe price says, because that is
 * what the client agreed to on the Checkout page. A disagreement between the
 * two is a configuration error worth surfacing loudly, not something to
 * paper over by preferring one side.
 */
export function expectedCentsForPlan(planKey: PlanKey): number | null {
  return PLANS.find((p) => p.key === planKey)?.monthlyCents ?? null;
}

/**
 * The subscription's Stripe status, mapped to what the portal stores.
 *
 * Stripe has eight statuses; `subscriptions.status` has three. The mapping is
 * deliberately lossy in one direction only — the raw Stripe status is kept
 * alongside in `provider_status`, so nothing that needs the detail has to
 * reconstruct it from this.
 *
 * `past_due` and `unpaid` map to `active`, not `paused`. Non-payment does not
 * end a subscription in this business: the dunning ladder handles it and
 * management pauses before hosting ever does. Mapping them to `paused` here
 * would make a client who missed one payment look cancelled in every rollup.
 */
export function portalStatusFor(
  stripeStatus: Stripe.Subscription.Status,
): "active" | "paused" | "cancelled" {
  switch (stripeStatus) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
      return "active";
    case "paused":
    case "incomplete":
      return "paused";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      return "paused";
  }
}

/**
 * The subscription id an invoice settles.
 *
 * `invoice.subscription` was moved to `invoice.parent.subscription_details`
 * in the 2025 API versions. Both are read because the two are not
 * interchangeable across versions and an integration that reads only the new
 * shape breaks against a replayed old event, while one that reads only the old
 * shape breaks today. The new location is preferred; the old is a fallback.
 */
export function subscriptionIdFromInvoice(
  invoice: Stripe.Invoice,
): string | null {
  const parent = (
    invoice as Stripe.Invoice & {
      parent?: {
        subscription_details?: { subscription?: string | { id: string } | null };
      } | null;
    }
  ).parent;

  const fromParent = parent?.subscription_details?.subscription;
  if (fromParent) {
    return typeof fromParent === "string" ? fromParent : fromParent.id;
  }

  const legacy = (
    invoice as Stripe.Invoice & {
      subscription?: string | { id: string } | null;
    }
  ).subscription;
  if (legacy) return typeof legacy === "string" ? legacy : legacy.id;

  return null;
}

/**
 * Whether an invoice represents money that actually arrived.
 *
 * `status === "paid"` is not the same question. An invoice for zero, one
 * settled entirely from customer credit, and one an operator marked paid by
 * hand are all `paid`, and none of them is card revenue. Reporting them as
 * collected cash overstates income — which is the kind of error that is only
 * noticed at tax time.
 *
 * `amount_paid` is the honest figure: what Stripe actually collected on this
 * invoice, in the smallest currency unit.
 */
export function collectedCents(invoice: Stripe.Invoice): number {
  return invoice.amount_paid ?? 0;
}
