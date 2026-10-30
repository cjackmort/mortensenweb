/**
 * Date labels for the payments page.
 *
 * A `date` column comes back as a bare "YYYY-MM-DD". `new Date(that)` parses
 * it as UTC midnight, so printing it in any timezone behind UTC shows the day
 * before; reading the parts out of the string sidesteps the parse.
 */

function parts(isoDate: string): [number, number, number] {
  const [year = 1970, month = 1, day = 1] = isoDate.split("-").map(Number);
  return [year, month, day];
}

/** "Oct 3", or "Oct 3, 2025" when the year is not `thisYear`. */
export function dayLabel(isoDate: string, thisYear?: string): string {
  const [year, month, day] = parts(isoDate);
  const showYear = thisYear !== undefined && String(year) !== thisYear;
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  });
}

/** An instant, as the business-calendar "Oct 18". */
export function instantLabel(at: Date): string {
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
  });
}

/** "October 2026". */
export function monthName(yearMonth: string): string {
  const [year, month] = parts(`${yearMonth}-01`);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function shiftMonth(yearMonth: string, n: number): string {
  const [y, m] = parts(`${yearMonth}-01`);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export const PURPOSE_LABEL: Record<string, string> = {
  subscription: "Monthly plan",
  extra_change: "Extra change",
  other: "One-off",
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
