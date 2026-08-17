/**
 * Square hosted checkout.
 *
 * What this is for: the client presses "unlock analytics", lands on a Square
 * page, pays the plan price, and optionally turns on recurring billing. Square
 * then tells us by webhook that money arrived, which is the part Venmo can
 * never do.
 *
 * Shapes below were taken from Square's published OpenAPI specification rather
 * than from memory, because two of them are easy to get subtly wrong:
 *
 *   POST /v2/online-checkout/payment-links
 *   CreatePaymentLinkRequest { idempotency_key, description, quick_pay, order,
 *                              checkout_options, pre_populated_data, payment_note }
 *   QuickPay (required)      { name, price_money, location_id }
 *   CheckoutOptions          { …, subscription_plan_id, redirect_url, … }
 *
 * In particular `subscription_plan_id` lives inside `checkout_options`, not at
 * the top level, and it wants a plan **variation** id rather than a plan id.
 *
 * ## What this module deliberately does not do
 *
 * It does not create catalogue subscription plans. Those are made once per plan
 * in the Square dashboard and their variation ids are configuration
 * (`service_plans.square_plan_variation_id`). Automating a five-minute task
 * done three times in the business's life, at the cost of carrying the Catalog
 * API, is a bad trade.
 *
 * It also does not decide that a client is paid up. A webhook can be delayed,
 * duplicated, or lost, so Square narrows the gap between "paid" and "confirmed"
 * that `payment_requests.awaiting_confirmation` exists to model — it does not
 * remove it.
 */

const PRODUCTION_BASE = "https://connect.squareup.com";
const SANDBOX_BASE = "https://connect.squareupsandbox.com";

/**
 * Square dates its API by version header. Pinning it means their changes arrive
 * when we choose to take them, rather than in the middle of a client's payment.
 */
const SQUARE_VERSION = "2026-05-20";

export class SquareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquareConfigError";
  }
}

export class SquareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SquareApiError";
  }
}

/**
 * Square needs three things to take a payment: a token, a location, and a
 * signature key to trust what it tells us afterwards. Missing any one of them
 * means the feature is off, not broken.
 */
export function isSquareConfigured(): boolean {
  return Boolean(
    process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID,
  );
}

/**
 * Sandbox unless explicitly told otherwise.
 *
 * The default matters. If the flag were "use sandbox when set", forgetting it
 * in development would charge real cards; this way, forgetting it in production
 * merely fails to take money, which is recoverable and loud.
 */
export function squareBaseUrl(): string {
  return process.env.SQUARE_ENVIRONMENT === "production"
    ? PRODUCTION_BASE
    : SANDBOX_BASE;
}

async function squareRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new SquareConfigError("SQUARE_ACCESS_TOKEN is not set.");

  const { method = "GET", body } = options;

  const response = await fetch(`${squareBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => undefined)) as
    | { errors?: Array<{ detail?: string; code?: string }> }
    | undefined;

  if (!response.ok) {
    // Square's error details name fields and codes, not card data — but they
    // are written for developers, so callers log this and never render it.
    const detail = payload?.errors?.[0]?.detail ?? payload?.errors?.[0]?.code;
    throw new SquareApiError(
      `Square request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`,
      response.status,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Checkout links
// ---------------------------------------------------------------------------

export interface CheckoutLink {
  /** Square's id for the link itself. Stored on the payment request. */
  id: string;
  url: string;
  orderId?: string;
}

export interface CheckoutLinkInput {
  /** Shown on the Square checkout page. Keep it recognisable to the payer. */
  name: string;
  amountCents: number;
  currency?: string;
  /**
   * Our reconciliation code (`MW-7F3K`). It rides along as the payment note so
   * a payment that arrives without a usable webhook can still be matched by
   * hand — the same role the code already plays for Venmo.
   */
  reference: string;
  /**
   * Square catalogue subscription plan **variation** id. When present, the
   * checkout enrols the payer in recurring billing rather than taking a single
   * payment.
   */
  planVariationId?: string;
  /** Where Square returns the client afterwards. */
  redirectUrl?: string;
  /**
   * Makes retries safe. Square treats a repeated key as the same request and
   * returns the original link instead of creating a second one — which is what
   * stops a double-clicked button from producing two live payment links for one
   * invoice.
   */
  idempotencyKey: string;
}

export async function createCheckoutLink(
  input: CheckoutLinkInput,
): Promise<CheckoutLink> {
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) throw new SquareConfigError("SQUARE_LOCATION_ID is not set.");

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new SquareApiError("A checkout amount must be positive cents.", 400);
  }

  const checkoutOptions: Record<string, unknown> = {};
  if (input.planVariationId) {
    checkoutOptions.subscription_plan_id = input.planVariationId;
  }
  if (input.redirectUrl) {
    checkoutOptions.redirect_url = input.redirectUrl;
  }

  const response = await squareRequest<{
    payment_link?: { id: string; url: string; order_id?: string };
  }>("/v2/online-checkout/payment-links", {
    method: "POST",
    body: {
      idempotency_key: input.idempotencyKey,
      quick_pay: {
        name: input.name,
        price_money: {
          amount: input.amountCents,
          currency: input.currency ?? "USD",
        },
        location_id: locationId,
      },
      // Appears on the payment record in Square's dashboard, which is where
      // reconciliation actually happens when something has gone sideways.
      payment_note: input.reference,
      ...(Object.keys(checkoutOptions).length
        ? { checkout_options: checkoutOptions }
        : {}),
    },
  });

  const link = response.payment_link;
  if (!link?.url || !link.id) {
    throw new SquareApiError("Square returned no payment link.", 502);
  }

  return { id: link.id, url: link.url, orderId: link.order_id };
}

// ---------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------

/**
 * The events worth acting on.
 *
 * Anything not listed is acknowledged and ignored. An allowlist rather than a
 * denylist because Square adds event types over time, and the safe response to
 * an event we have never heard of is to do nothing with it.
 */
export const HANDLED_SQUARE_EVENTS = new Set([
  "payment.created",
  "payment.updated",
  "invoice.payment_made",
  "subscription.created",
  "subscription.updated",
]);

export interface SquarePaymentEvent {
  eventId: string;
  type: string;
  paymentId?: string;
  orderId?: string;
  /** Square's status: only `COMPLETED` means the money is actually ours. */
  status?: string;
  amountCents?: number;
  currency?: string;
  /** Our reference code, recovered from the payment note. */
  note?: string;
  subscriptionId?: string;
}

/**
 * Pull the few fields we use out of a Square notification.
 *
 * Written defensively and returning `null` rather than throwing: this parses a
 * payload from the network, and a shape we did not expect is an event to skip,
 * not a request to fail. Every field is optional in practice even where the
 * documentation implies otherwise.
 */
export function parseSquareEvent(payload: unknown): SquarePaymentEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  const eventId = typeof root.event_id === "string" ? root.event_id : null;
  const type = typeof root.type === "string" ? root.type : null;
  if (!eventId || !type) return null;

  const data = root.data as Record<string, unknown> | undefined;
  const object = data?.object as Record<string, unknown> | undefined;

  const payment = object?.payment as Record<string, unknown> | undefined;
  const subscription = object?.subscription as
    | Record<string, unknown>
    | undefined;

  const money = payment?.amount_money as Record<string, unknown> | undefined;

  return {
    eventId,
    type,
    paymentId: typeof payment?.id === "string" ? payment.id : undefined,
    orderId: typeof payment?.order_id === "string" ? payment.order_id : undefined,
    status: typeof payment?.status === "string" ? payment.status : undefined,
    amountCents: typeof money?.amount === "number" ? money.amount : undefined,
    currency: typeof money?.currency === "string" ? money.currency : undefined,
    note: typeof payment?.note === "string" ? payment.note : undefined,
    subscriptionId:
      typeof subscription?.id === "string" ? subscription.id : undefined,
  };
}

/**
 * Recover our reconciliation code from a Square note.
 *
 * The note is free text that a payer can edit on some rails, so this looks for
 * the code's shape anywhere in the string rather than requiring an exact match.
 * A miss means the payment lands in the unmatched queue for a human, which is
 * the correct outcome — guessing which invoice an unlabelled payment settles is
 * how a client gets marked paid for someone else's money.
 */
// The same Crockford-ish alphabet `generatePaymentReference` draws from, with
// I, L, O and U excluded because they get misread when a code is read aloud.
const REFERENCE_PATTERN = /\bMW-[0-9A-HJKMNP-TV-Z]{4}\b/i;

export function referenceFromNote(note: string | undefined): string | null {
  if (!note) return null;
  return REFERENCE_PATTERN.exec(note)?.[0]?.toUpperCase() ?? null;
}
