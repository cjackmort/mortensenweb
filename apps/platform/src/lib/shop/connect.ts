import type Stripe from "stripe";

/**
 * Stripe Connect for client shops: the pure parts.
 *
 * A client's shop takes money on the client's own Stripe account, a Standard
 * connected account under the portal's platform account. The portal never
 * holds the money and never sees a card: it creates the account object when
 * the client presses "Connect Stripe", sends them through Stripe's hosted
 * onboarding, and stores the account id. Payouts, receipts, refunds and
 * disputes are theirs, in their own Stripe dashboard.
 *
 * Events for connected accounts arrive on a second webhook endpoint with a
 * second signing secret (`STRIPE_CONNECT_WEBHOOK_SECRET`). Pointing the
 * platform endpoint at them silently drops them, which is why the receiver and
 * the event list are separate from `lib/payments/stripe.ts`.
 */

/** The settings page, where onboarding starts and where Stripe sends the client back. */
export const SHOP_SETTINGS_PATH = "/dashboard/growth/shop/settings";

/**
 * Events the Connect receiver acts on. Anything else is acknowledged and
 * dropped, the same allowlist rule as the platform receiver.
 */
export const HANDLED_CONNECT_EVENTS = new Set([
  "account.updated",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.expired",
  "charge.refunded",
]);

export function connectWebhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
}

/**
 * The portal's own origin, for the URLs Stripe sends the client back to.
 *
 * Null when it is not set: a return URL guessed from a request header could
 * be whatever a request claimed, and Stripe would send the client there.
 */
export function portalOrigin(): string | null {
  const base = (process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL)?.trim();
  return base ? base.replace(/\/+$/, "") : null;
}

export type ConnectReturn = "return" | "refresh";

/** Where Stripe sends the client after onboarding, and where it sends them when a link has expired. */
export function connectReturnUrl(origin: string, outcome: ConnectReturn): string {
  return `${origin}${SHOP_SETTINGS_PATH}?stripe=${outcome}`;
}

/**
 * The three facts about a connected account the shop cares about.
 *
 * `chargesEnabled` is the gate on checkout and the only one stored: a shop
 * cannot sell until Stripe will take the money. The other two explain the
 * state in between to the client.
 */
export interface ConnectedAccountStatus {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
}

export function accountStatusOf(account: Stripe.Account): ConnectedAccountStatus {
  return {
    chargesEnabled: account.charges_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    payoutsEnabled: account.payouts_enabled === true,
  };
}

/**
 * The connected account an event is about.
 *
 * On a Connect endpoint every event carries `account`; for `account.updated`
 * the object is the account itself, so its id is the same thing. Both are
 * read because an event replayed from the dashboard to the wrong endpoint
 * carries no `account`, and an event about nothing is ignored rather than
 * matched to whatever is handy.
 */
export function connectedAccountIdOf(event: Stripe.Event): string | null {
  if (event.account) return event.account;
  const object = event.data.object as { object?: string; id?: string };
  return object.object === "account" && object.id ? object.id : null;
}
