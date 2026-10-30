import { z } from "zod";
import { emptyWeek, type FullWeek, type TimeRange } from "./slots";
import { clockToMinutes, isIsoDate, isTimeZone, MINUTES_PER_DAY, type IsoDate } from "./time";

/**
 * What a client can set on the Availability page, and the checks every
 * value passes before it is stored. Pure, so the server actions and the
 * tests read the forms the same way.
 */

export interface AvailabilityRules {
  timeZone: string;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  requiresApproval: boolean;
}

/** What a client who has saved nothing yet starts from. */
export const DEFAULT_RULES: AvailabilityRules = {
  timeZone: "America/Denver",
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeMinutes: 120,
  horizonDays: 30,
  requiresApproval: false,
};

export const SLOT_LENGTHS = [15, 20, 30, 45, 60, 90, 120] as const;
export const BUFFERS = [0, 5, 10, 15, 30, 60] as const;
export const NOTICES = [0, 60, 120, 240, 720, 1440, 2880, 10080] as const;
export const HORIZONS = [7, 14, 30, 60, 90] as const;

/** Every client is in the US; the zones they are in, by the name they use. */
export const TIME_ZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona (no daylight saving)" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

/** Plenty for split shifts; a ceiling on a form posted by hand. */
export const MAX_RANGES_PER_DAY = 6;

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const rulesSchema = z.object({
  timeZone: z.string().refine(isTimeZone, "Pick a timezone from the list."),
  slotMinutes: z.coerce.number().int().min(5, "Appointments are at least 5 minutes.").max(480, "Appointments are at most 8 hours."),
  bufferMinutes: z.coerce.number().int().min(0).max(240, "Keep the gap under 4 hours."),
  minNoticeMinutes: z.coerce.number().int().min(0).max(43200, "Keep the notice under 30 days."),
  horizonDays: z.coerce.number().int().min(1, "Offer at least today.").max(90, "Offer up to 90 days ahead."),
  requiresApproval: z.boolean(),
});

/** The booking-rules form. A checkbox that is not ticked is not sent, so it is read by presence. */
export function parseRules(form: {
  timeZone: unknown;
  slotMinutes: unknown;
  bufferMinutes: unknown;
  minNoticeMinutes: unknown;
  horizonDays: unknown;
  requiresApproval: unknown;
}): Parsed<AvailabilityRules> {
  const parsed = rulesSchema.safeParse({ ...form, requiresApproval: form.requiresApproval === "on" || form.requiresApproval === true });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the booking rules." };
  return { ok: true, value: parsed.data };
}

const clockRange = z.object({ start: z.string().max(5), end: z.string().max(5) });
const weekSchema = z.record(z.string().regex(/^[0-6]$/), z.array(clockRange).max(MAX_RANGES_PER_DAY));

/**
 * One range from two clock times. An end of `00:00` is midnight at the end of
 * the day — the only way a time field can say "until midnight".
 */
export function readRange(start: string, end: string): TimeRange | null {
  const from = clockToMinutes(start);
  let to = clockToMinutes(end);
  if (from === null || to === null) return null;
  if (to === 0) to = MINUTES_PER_DAY;
  return from < to && from < MINUTES_PER_DAY ? { start: from, end: to } : null;
}

/**
 * The weekly-hours editor's JSON: `{ "1": [{ "start": "09:00", "end": "17:00" }] }`.
 * Every weekday comes back, closed ones empty, so saving is a whole week.
 */
export function parseWeeklyHours(raw: unknown): Parsed<FullWeek> {
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, message: "The hours could not be read. Reload the page and try again." };
    }
  }
  const parsed = weekSchema.safeParse(json);
  if (!parsed.success) return { ok: false, message: "The hours could not be read. Reload the page and try again." };

  const week: FullWeek = emptyWeek();
  for (const [key, ranges] of Object.entries(parsed.data)) {
    const day = Number(key);
    const read: TimeRange[] = [];
    for (const r of ranges) {
      const range = readRange(r.start, r.end);
      if (!range) {
        return { ok: false, message: `${WEEKDAY_NAMES[day]}: each block of hours needs a start before its end.` };
      }
      read.push(range);
    }
    week[day as keyof FullWeek] = read;
  }
  return { ok: true, value: week };
}

export interface OverrideInput {
  date: IsoDate;
  /** Empty: closed all day. */
  ranges: TimeRange[];
}

/** "Days off and different hours": a date, and either closed or one block of hours. */
export function parseOverride(
  form: { date: unknown; mode: unknown; start: unknown; end: unknown },
  today: IsoDate,
): Parsed<OverrideInput> {
  if (!isIsoDate(form.date)) return { ok: false, message: "Pick a date." };
  if (form.date < today) return { ok: false, message: "That date has already passed." };
  if (form.mode === "closed") return { ok: true, value: { date: form.date, ranges: [] } };
  if (form.mode !== "hours") return { ok: false, message: "Choose closed, or different hours." };
  const range = readRange(String(form.start ?? ""), String(form.end ?? ""));
  if (!range) return { ok: false, message: "Give the hours for that day, with the start before the end." };
  return { ok: true, value: { date: form.date, ranges: [range] } };
}

/** Ranges as stored, re-checked on the way out: a row edited by hand must not crash the slot engine. */
export function readStoredRanges(raw: unknown): TimeRange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const { start, end } = (r ?? {}) as { start?: unknown; end?: unknown };
    return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) <= MINUTES_PER_DAY && (start as number) < (end as number)
      ? [{ start: start as number, end: end as number }]
      : [];
  });
}
