/**
 * Wall-clock time in the business's timezone, without a date library.
 *
 * Availability is written the way a business owner says it — "Mondays, 9 to
 * 5" — and kept that way: a weekday, minutes after local midnight. It becomes
 * an instant only when a slot is drawn, here, for one calendar date at a time.
 * So 9 AM stays 9 AM across a daylight-saving change; converting the hours
 * to UTC once and repeating them weekly would move every appointment by an
 * hour twice a year.
 *
 * Dates are `YYYY-MM-DD` strings and their arithmetic is done in UTC, where a
 * day is always 24 hours. Only `zonedTimeToInstant` and the readers below it
 * know about timezones, and they ask `Intl` for the offset rather than
 * assuming one.
 */

export type IsoDate = string;

export const MINUTES_PER_DAY = 1440;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in `YYYY-MM-DD` form. `2026-02-30` is not one. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function dayStartUtc(date: IsoDate): number {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`Not a date: ${date}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatUtcDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return formatUtcDate(dayStartUtc(date) + days * DAY_MS);
}

/** 0 is Sunday, as `Date#getDay` counts. */
export function weekdayOf(date: IsoDate): number {
  return new Date(dayStartUtc(date)).getUTCDay();
}

/** Whether `Intl` knows the zone. A typo would otherwise throw at the first slot. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(timeZone: string, instant: number): Record<string, number> {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormatters.set(timeZone, formatter);
  }
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

/** The zone's offset from UTC at an instant, in minutes: Denver in winter is -420. */
export function offsetMinutes(timeZone: string, instant: number): number {
  const p = partsIn(timeZone, instant);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour === 24 ? 0 : p.hour!, p.minute!, p.second!);
  const wholeSeconds = Math.floor(instant / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / MINUTE_MS);
}

/**
 * The instant at which a wall-clock time happens on a date in a zone.
 * `minuteOfDay` may be 1440: the midnight that ends the day.
 *
 * Two times a year a wall-clock time is not one instant. In the spring gap
 * (2:30 AM on the night clocks jump to 3) it never happens, and is moved
 * forward by the gap — 3:30. In the autumn overlap (1:30 AM twice) the first
 * is taken. These are the rules most calendars follow, and the ones
 * `Temporal` calls "compatible".
 */
export function zonedTimeToInstant(date: IsoDate, minuteOfDay: number, timeZone: string): Date {
  const wall = dayStartUtc(date) + minuteOfDay * MINUTE_MS;
  // A day either side reaches past any transition near this time; no zone
  // changes its offset twice in two days.
  const before = offsetMinutes(timeZone, wall - DAY_MS);
  const after = offsetMinutes(timeZone, wall + DAY_MS);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset * MINUTE_MS)
    .filter((instant) => offsetMinutes(timeZone, instant) === (wall - instant) / MINUTE_MS);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  return new Date(wall - before * MINUTE_MS);
}

/** The calendar date in the zone at an instant. */
export function dateInZone(instant: Date, timeZone: string): IsoDate {
  const p = partsIn(timeZone, instant.getTime());
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes after local midnight at an instant. */
export function minuteOfDayInZone(instant: Date, timeZone: string): number {
  const p = partsIn(timeZone, instant.getTime());
  return (p.hour === 24 ? 0 : p.hour!) * 60 + p.minute!;
}

/** `540` → `09:00`; `1440` → `24:00`. For forms and stored ranges. */
export function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * `09:00` → `540`. `24:00` is the end of the day. Anything else that is not a
 * clock time is null, so a form can tell "blank" from "nonsense".
 */
export function clockToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= MINUTES_PER_DAY ? minutes : null;
}
