/**
 * Venmo hand-off.
 *
 * Venmo provides no callback for peer payments, so this module can only ever
 * take the client *to* Venmo with the right fields filled in. It cannot know
 * whether money arrived. Every function here is named to keep that honest:
 * nothing in this file marks anything paid.
 *
 * Reconciliation works through the reference code, which is placed in the
 * Venmo note. When a payment lands in the operator's Venmo feed, the note
 * identifies which request it settles.
 */

const VENMO_WEB_BASE = "https://venmo.com/";

/** Crockford-ish alphabet: no I, L, O, U — these get misread in a Venmo note. */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomIndex(upperBound: number): number {
  const limit = Math.floor(0xffffffff / upperBound) * upperBound;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return value % upperBound;
}

/**
 * A short, quotable reference such as `MW-7F3K`.
 *
 * Short enough to read aloud, long enough that two open requests will not
 * collide in practice. Uniqueness is enforced by a unique index, not by hope —
 * the caller retries on conflict.
 */
export function generatePaymentReference(prefix = "MW"): string {
  let body = "";
  for (let i = 0; i < 4; i += 1) {
    body += REFERENCE_ALPHABET[randomIndex(REFERENCE_ALPHABET.length)];
  }
  return `${prefix}-${body}`;
}

/** Strip a leading @ and whitespace from a configured Venmo handle. */
export function normaliseVenmoHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "");
}

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{5,30}$/;

export function isValidVenmoHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(normaliseVenmoHandle(handle));
}

export interface VenmoPaymentLinkInput {
  /** The agency's receiving handle, from VENMO_HANDLE. */
  handle: string;
  amountCents: number;
  /** Reference code; always included so the payment can be reconciled. */
  reference: string;
  businessName: string;
}

/**
 * Build the Venmo payment URL.
 *
 * `audience=private` is deliberate and not a default worth changing: Venmo's
 * feed is public unless told otherwise, and a stream of payments annotated with
 * client business names would disclose the agency's customer list to anyone who
 * looked.
 */
export function buildVenmoPaymentUrl(input: VenmoPaymentLinkInput): string {
  const handle = normaliseVenmoHandle(input.handle);
  if (!isValidVenmoHandle(handle)) {
    throw new Error("VENMO_HANDLE is not a valid Venmo username.");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Payment amount must be a positive whole number of cents.");
  }

  const url = new URL(VENMO_WEB_BASE);
  url.searchParams.set("txn", "pay");
  url.searchParams.set("audience", "private");
  url.searchParams.set("recipients", handle);
  url.searchParams.set("amount", formatAmount(input.amountCents));
  url.searchParams.set("note", buildNote(input.reference, input.businessName));
  return url.toString();
}

/** Cents to the decimal string Venmo expects. Never floating point maths. */
export function formatAmount(amountCents: number): string {
  const whole = Math.floor(amountCents / 100);
  const fraction = String(amountCents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * The note the client sends with the payment.
 *
 * Reference first, because Venmo truncates long notes in the feed and the
 * reference is the part that must survive.
 */
export function buildNote(reference: string, businessName: string): string {
  const base = `${reference} — website services`;
  const withName = `${base} — ${businessName}`;
  return withName.length <= 100 ? withName : base;
}

/** Human-readable amount for the UI. */
export function formatCurrency(amountCents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}

/**
 * Whether Venmo hand-off is configured. When false the UI shows payment
 * instructions without a button, rather than a button that goes nowhere.
 */
export function isVenmoConfigured(): boolean {
  const handle = process.env.VENMO_HANDLE;
  return Boolean(handle && isValidVenmoHandle(handle));
}

export function configuredVenmoHandle(): string | null {
  const handle = process.env.VENMO_HANDLE;
  if (!handle || !isValidVenmoHandle(handle)) return null;
  return normaliseVenmoHandle(handle);
}
