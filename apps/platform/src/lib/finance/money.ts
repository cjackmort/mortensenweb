/**
 * Dollars as typed by a human, to whole cents. `$1,234.56`, `19`, `19.5`.
 * Null for anything else, including zero, negatives and a third decimal: a
 * ledger amount that had to be guessed at is worse than one refused.
 *
 * The one place a typed amount becomes cents, so no float reaches the
 * database and every form on the payments page agrees on what it accepts.
 */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number.parseFloat(cleaned) * 100);
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}

/** Cents as a plain decimal for an input's default value: `2500` → `25.00`. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
