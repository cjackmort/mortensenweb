import {
  addDays,
  dateInZone,
  MINUTES_PER_DAY,
  weekdayOf,
  zonedTimeToInstant,
  type IsoDate,
} from "./time";

/**
 * The slot engine: which times a website offers.
 *
 *   weekly hours
 *   − days off and custom hours for a date
 *   − busy times read from the client's Google Calendar
 *   − bookings already pending or confirmed
 *   − anything sooner than the minimum notice, or past the horizon
 *   = open slots
 *
 * Pure: everything it needs is passed in, including "now", so the page's
 * preview, the public feed and the booking re-check all draw the same slots
 * from the same inputs, and the tests can pin every edge.
 *
 * Slots start where a range starts and follow on every `slotMinutes`, counted
 * in real time from that instant — so on the night the clocks change, a
 * range that crosses 2 AM holds an hour more or less, as it does on the wall.
 * The buffer is not a gap between every slot: it is the clear time kept
 * around anything already in the diary, so an empty day still offers 9:00,
 * 9:30, 10:00 and a booked 9:00 pushes the next offer to 10:00 with a
 * 15-minute buffer, not to 9:45.
 */

/** Minutes after local midnight; `end` may be 1440. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Keyed by weekday, 0 = Sunday. A missing or empty day is closed. */
export type WeeklyHours = Partial<Record<number, TimeRange[]>>;

/** Every weekday present, closed ones empty: what is stored and edited. */
export type FullWeek = { [Day in 0 | 1 | 2 | 3 | 4 | 5 | 6]: TimeRange[] };

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export function emptyWeek(): FullWeek {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

/** A date's own hours in place of its weekday's. Empty ranges: closed all day. */
export interface DateOverride {
  date: IsoDate;
  ranges: TimeRange[];
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface SlotRules {
  timeZone: string;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  /** Bookable dates run from today for this many days, today included. */
  horizonDays: number;
}

export interface SlotInput extends SlotRules {
  weekly: WeeklyHours;
  overrides: DateOverride[];
  /** From Google Calendar. */
  busy: Interval[];
  /** Pending and confirmed bookings: both hold their time. */
  booked: Interval[];
  now: Date;
  /** Local dates, inclusive. Clipped to today … the horizon. */
  from?: IsoDate;
  to?: IsoDate;
}

export interface Slot {
  start: Date;
  end: Date;
  /** The business's calendar date the slot is on. */
  date: IsoDate;
}

const MINUTE_MS = 60_000;

/** Sorted, overlapping and touching ranges merged, anything impossible dropped. */
export function normalizeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const valid = ranges
    .filter(
      (r) =>
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= 0 &&
        r.end <= MINUTES_PER_DAY &&
        r.start < r.end,
    )
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);

  return valid.reduce<TimeRange[]>((merged, next) => {
    const last = merged.at(-1);
    if (last && next.start <= last.end) {
      return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, next.end) }];
    }
    return [...merged, next];
  }, []);
}

/** The first and last date a booking can be made for, in the business's days. */
export function bookableWindow(rules: SlotRules, now: Date): { first: IsoDate; last: IsoDate } {
  const first = dateInZone(now, rules.timeZone);
  return { first, last: addDays(first, Math.max(1, rules.horizonDays) - 1) };
}

/** The ranges that apply on a date: its own if it has any, else its weekday's. */
export function rangesOn(date: IsoDate, weekly: WeeklyHours, overrides: ReadonlyMap<IsoDate, TimeRange[]>): TimeRange[] {
  return normalizeRanges(overrides.get(date) ?? weekly[weekdayOf(date)] ?? []);
}

function clashes(start: number, end: number, blocks: readonly Interval[], bufferMs: number): boolean {
  return blocks.some((b) => start < b.end.getTime() + bufferMs && end + bufferMs > b.start.getTime());
}

export function openSlots(input: SlotInput): Slot[] {
  const window = bookableWindow(input, input.now);
  const first = input.from && input.from > window.first ? input.from : window.first;
  const last = input.to && input.to < window.last ? input.to : window.last;
  if (first > last || input.slotMinutes <= 0) return [];

  const overrides = new Map(input.overrides.map((o) => [o.date, o.ranges]));
  const blocks = [...input.busy, ...input.booked];
  const slotMs = input.slotMinutes * MINUTE_MS;
  const bufferMs = Math.max(0, input.bufferMinutes) * MINUTE_MS;
  const earliest = input.now.getTime() + Math.max(0, input.minNoticeMinutes) * MINUTE_MS;

  const slots: Slot[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    for (const range of rangesOn(date, input.weekly, overrides)) {
      const rangeStart = zonedTimeToInstant(date, range.start, input.timeZone).getTime();
      const rangeEnd = zonedTimeToInstant(date, range.end, input.timeZone).getTime();
      for (let start = rangeStart; start + slotMs <= rangeEnd; start += slotMs) {
        if (start < earliest) continue;
        if (clashes(start, start + slotMs, blocks, bufferMs)) continue;
        slots.push({ start: new Date(start), end: new Date(start + slotMs), date });
      }
    }
  }
  return slots;
}

/**
 * The slot a booking asks for, if it is still one the website would offer
 * right now. Anything else — a start between slots, a time since taken, a
 * day since closed — is null: the request is checked against the rules as
 * they are, not as they were when the page loaded.
 */
export function findOpenSlot(input: SlotInput, start: Date): Slot | null {
  const date = dateInZone(start, input.timeZone);
  return openSlots({ ...input, from: date, to: date }).find((s) => s.start.getTime() === start.getTime()) ?? null;
}
