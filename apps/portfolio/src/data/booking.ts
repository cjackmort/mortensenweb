/**
 * The "Book a call" button on /contact/. Null means no button, which is the
 * default: a scheduling link that goes nowhere is worse than no button at all.
 *
 * To turn it on: make the event in a free Cal.com account (or any scheduler
 * with a public booking page), open the page in a private window to check it
 * takes a booking, then paste its address here and deploy:
 *
 *   export const BOOKING_URL: string | null = "https://cal.com/mortensenweb/intro-call";
 *
 * The build refuses anything that is not an https address, so a typo fails
 * the deploy instead of shipping a broken button.
 */
export const BOOKING_URL: string | null = null;

function checked(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`BOOKING_URL in src/data/booking.ts is not a web address: "${url}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`BOOKING_URL in src/data/booking.ts must start with https:// — got "${url}"`);
  }
  return parsed.href;
}

/** The checked booking address, or null when the button stays hidden. */
export const BOOKING = checked(BOOKING_URL);
