/**
 * Money as a client types it and as the shop shows it. Cents everywhere in
 * between: the database, Stripe and the tests all count in integers.
 */

/**
 * Dollars typed by a person to cents. "12", "12.5", "$12.50" and " 1,250 "
 * are all read; anything else is a refusal, never a guess.
 */
export function parseDollars(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** Cents to "$1,250.00". Always two decimals: a shop price is never "$12". */
export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
