/**
 * Month arithmetic for the booking calendar beside a venue's inbox.
 *
 * Everything here is a calendar date string (`YYYY-MM-DD`) or month
 * (`YYYY-MM`), computed in UTC. A show is on a day, not at an instant, and a
 * grid built from a local `Date` draws the wrong first weekday wherever the
 * server's clock is on the other side of midnight.
 */

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

function parts(month: string): [number, number] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return [y, m];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-11-14` → `2026-11`. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = parts(month);
  const shifted = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

function daysIn(month: string): number {
  const [y, m] = parts(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthBounds(month: string): { first: string; last: string } {
  return { first: `${month}-01`, last: `${month}-${pad(daysIn(month))}` };
}

/** The month as weeks, Sunday first, `null` for the days outside it. */
export function monthWeeks(month: string): (string | null)[][] {
  const [y, m] = parts(month);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysIn(month); day += 1) cells.push(`${month}-${pad(day)}`);
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** `2026-11` → `November 2026`. */
export function formatMonth(month: string): string {
  const [y, m] = parts(month);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
