import { formatSlotTime } from "./format";
import { rangesOn, type FullWeek, type TimeRange } from "./slots";
import { dateInZone, MINUTES_PER_DAY, type IsoDate } from "./time";

/**
 * What the Availability calendar says about a day, worked out apart from the
 * screen so the rule is the slot engine's own: a date's own hours win, else
 * its weekday's.
 */

export interface DayHours {
  /** Sorted and merged, as the website will offer them. Empty: closed. */
  ranges: TimeRange[];
  /** The date has hours of its own (possibly none), rather than following its weekday. */
  own: boolean;
}

export function dayHours(date: IsoDate, weekly: FullWeek, overrides: ReadonlyMap<IsoDate, TimeRange[]>): DayHours {
  return { ranges: rangesOn(date, weekly, overrides), own: overrides.has(date) };
}

/** `540` → `9a`, `570` → `9:30a`, `1020` → `5p`; midnight is `12a`. */
function compactClock(minutes: number): string {
  const m = minutes % MINUTES_PER_DAY;
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  const suffix = hours >= 12 ? "p" : "a";
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour}${mins === 0 ? "" : `:${String(mins).padStart(2, "0")}`}${suffix}`;
}

/** What fits in a calendar cell: `9a–5p`, `9a–12p +1` for a second block, or `Closed`. */
export function compactHours(ranges: readonly TimeRange[]): string {
  const first = ranges[0];
  if (!first) return "Closed";
  const head = `${compactClock(first.start)}–${compactClock(first.end)}`;
  return ranges.length > 1 ? `${head} +${ranges.length - 1}` : head;
}

export interface ClockFields {
  start: string;
  end: string;
}

/**
 * Ranges as the editor's `<input type="time">` fields hold them. A time field
 * has no 24:00, so the end of the day is `00:00` — which the server reads back
 * as the end of the day, never the start.
 */
export function rangesToFields(ranges: readonly TimeRange[]): ClockFields[] {
  const clock = (minutes: number) => {
    const m = minutes % MINUTES_PER_DAY;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return ranges.map((r) => ({ start: clock(r.start), end: clock(r.end) }));
}

/** `Tuesday`, for the date. A date is a day, not an instant, so it is read in UTC. */
export function weekdayName(date: IsoDate): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

export interface DayBooking {
  publicId: string;
  /** `10:00 AM`. */
  time: string;
  name: string;
  status: "pending" | "confirmed";
}

/**
 * Pending and confirmed bookings grouped by date, soonest first, each on the
 * date it falls on in its own zone: a 9 PM booking in Denver is the next day
 * in UTC, and the calendar must show it on the day the client will be there.
 */
export function bookingsByDate(
  bookings: ReadonlyArray<{
    publicId: string;
    customerName: string;
    startsAt: Date;
    timeZone: string;
    status: "pending" | "confirmed";
  }>,
): Record<IsoDate, DayBooking[]> {
  const days: Record<IsoDate, DayBooking[]> = {};
  const soonestFirst = [...bookings].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const b of soonestFirst) {
    const date = dateInZone(b.startsAt, b.timeZone);
    days[date] = [
      ...(days[date] ?? []),
      { publicId: b.publicId, time: formatSlotTime(b.startsAt, b.timeZone), name: b.customerName, status: b.status },
    ];
  }
  return days;
}
