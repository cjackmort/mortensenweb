/**
 * Calendar months, in the business's timezone.
 *
 * Every allowance question — "how many changes are left this month?" — needs a
 * month boundary, and there is exactly one correct one: the operator's local
 * calendar month. A UTC month rolls over at 5pm or 6pm Denver time depending on
 * daylight saving, which would give a client on the last evening of the month
 * an allowance that resets while they are using it, and would give the operator
 * a monthly total that does not match their own calendar.
 *
 * `Intl.DateTimeFormat` with `en-CA` is used rather than date arithmetic
 * because it formats as `YYYY-MM-DD` and — crucially — performs the timezone
 * conversion itself, including DST transitions, without this module needing to
 * know when those happen.
 */

export function businessTimezone(): string {
  return process.env.BUSINESS_TIMEZONE ?? "America/Denver";
}

/** `YYYY-MM-DD` for an instant, in the business timezone. */
export function businessDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export interface BillingPeriod {
  /** First day of the month, `YYYY-MM-DD`. The key an allowance row is stored under. */
  start: string;
  /** Last day of the month, inclusive. */
  end: string;
}

/**
 * The calendar month containing an instant.
 *
 * The end date is computed as "day zero of the following month", which is how
 * you get the last day of a month without a table of month lengths and without
 * a leap-year special case.
 */
export function currentPeriod(at: Date = new Date()): BillingPeriod {
  const today = businessDate(at);
  const [year, month] = today.split("-").map(Number) as [number, number, number];

  const start = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;

  // Day 0 of next month === last day of this one. UTC throughout: these are
  // calendar labels being manipulated, not instants, and mixing in a local
  // offset here is what makes month arithmetic go wrong at the boundaries.
  const lastDay = new Date(Date.UTC(year, month, 0));
  const end = `${lastDay.getUTCFullYear()}-${String(lastDay.getUTCMonth() + 1).padStart(2, "0")}-${String(lastDay.getUTCDate()).padStart(2, "0")}`;

  return { start, end };
}

/** Human label for a period, e.g. "August 2026". */
export function periodLabel(period: BillingPeriod): string {
  const [year, month] = period.start.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
