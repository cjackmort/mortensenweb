/**
 * The day of the month a client pays, and how it maps onto Stripe.
 *
 * Kept to 1–28, matching `subscriptions.billing_day`. A 29th–31st does not
 * exist in every month; Stripe would move it to the last day, and the day the
 * operator chose would quietly stop being the day the client is charged.
 *
 * Stripe anchors in UTC, so "today" here is the UTC date. Everything else in
 * billing uses the business timezone; this is the one place that must not.
 */

export const FIRST_BILLING_DAY = 1;
export const LAST_BILLING_DAY = 28;

/** A form value as a billing day, or null when it is not one. */
export function parseBillingDay(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw.trim())) return null;
  const day = Number(raw.trim());
  return day >= FIRST_BILLING_DAY && day <= LAST_BILLING_DAY ? day : null;
}

/**
 * The `day_of_month` to anchor a new subscription on, or null for none.
 *
 * None when the day is today: a subscription started today already renews on
 * today's date, and anchoring on it as well would push the first full payment
 * a month out after billing most of a month as a proration.
 */
export function anchorDayFor(billingDay: number, now: Date = new Date()): number | null {
  return now.getUTCDate() === billingDay ? null : billingDay;
}

/** The billing day a Stripe anchor (unix seconds) lands on, kept in 1–28. */
export function billingDayFromAnchor(anchorSeconds: number): number {
  const day = new Date(anchorSeconds * 1000).getUTCDate();
  return Math.min(LAST_BILLING_DAY, Math.max(FIRST_BILLING_DAY, day));
}

/**
 * When an existing subscription's next payment should fall, to move it onto
 * `billingDay`. Unix seconds, or null when it already renews on that day.
 *
 * The first occurrence of the day *after* the period already paid for, at the
 * same time of day. Never earlier: a payment inside a paid period charges the
 * client twice for the same days. The days between the old renewal and the new
 * one go uncharged, which is the safe direction to be wrong in.
 */
export function shiftedAnchor(billingDay: number, periodEndSeconds: number): number | null {
  const end = new Date(periodEndSeconds * 1000);
  if (end.getUTCDate() === billingDay) return null;

  const next = new Date(end);
  next.setUTCDate(billingDay);
  if (next.getTime() <= end.getTime()) next.setUTCMonth(next.getUTCMonth() + 1, billingDay);

  return Math.floor(next.getTime() / 1000);
}

/** 1st, 2nd, 3rd, 4th … 21st, 22nd, 23rd … 28th. */
export function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  return `${day}${suffix}`;
}
