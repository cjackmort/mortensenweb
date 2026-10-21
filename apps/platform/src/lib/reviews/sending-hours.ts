/**
 * When an automatic reminder may go out: 9am to 8pm where the business is.
 *
 * The scheduler runs around the clock, and a reminder that lands at 3am reads
 * as spam, or worse for a text: the TCPA's quiet hours are 8am to 9pm in the
 * recipient's time, and this sits inside them. Every client is local, so the
 * business's timezone stands in for the customer's.
 *
 * A reminder that comes due at night waits for the first run after 9am. The
 * scheduler sweeps at least every six hours, so one always lands in the window.
 */

export const SENDING_STARTS_AT_HOUR = 9;
export const SENDING_ENDS_AT_HOUR = 20;

export function isWithinSendingHours(now: Date, timeZone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now),
  );
  return hour >= SENDING_STARTS_AT_HOUR && hour < SENDING_ENDS_AT_HOUR;
}
