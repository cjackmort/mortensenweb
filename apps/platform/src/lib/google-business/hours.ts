import { emptyWeek } from "./normalize";
import { WEEKDAYS, type HoursRange, type SpecialDay, type WeeklyHours, type Weekday } from "./types";

/**
 * Hours, for people: reading the operator's form, and saying them out loud.
 *
 * The form is one row per day — closed, open all day, or up to two ranges
 * (a lunch break is the common case for two). Anything Google holds beyond
 * that is rare for a small business and is edited in Google itself; the form
 * says so rather than silently dropping a third range on save.
 */

export const DAY_LABELS: Record<Weekday, { short: string; long: string }> = {
  MONDAY: { short: "Mon", long: "Monday" },
  TUESDAY: { short: "Tue", long: "Tuesday" },
  WEDNESDAY: { short: "Wed", long: "Wednesday" },
  THURSDAY: { short: "Thu", long: "Thursday" },
  FRIDAY: { short: "Fri", long: "Friday" },
  SATURDAY: { short: "Sat", long: "Saturday" },
  SUNDAY: { short: "Sun", long: "Sunday" },
};

export const MAX_RANGES_PER_DAY = 2;
/** New special-hours rows offered under the existing ones. */
export const NEW_SPECIAL_ROWS = 3;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function formatClock(clock: string): string {
  if (clock === "24:00" || clock === "00:00") return "midnight";
  const [h, m] = clock.split(":").map(Number);
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  const suffix = h! < 12 ? "am" : "pm";
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

export function formatRanges(ranges: HoursRange[]): string {
  if (ranges.length === 0) return "Closed";
  if (ranges.length === 1 && ranges[0]!.open === "00:00" && ranges[0]!.close === "24:00") return "Open 24 hours";
  return ranges.map((r) => `${formatClock(r.open)} – ${formatClock(r.close)}`).join(", ");
}

/** "Mon–Fri: 8 am – 5 pm", with runs of identical days joined. */
export function describeWeek(week: WeeklyHours): Array<{ days: string; hours: string }> {
  const lines: Array<{ days: string; hours: string }> = [];
  let start = 0;
  for (let i = 1; i <= WEEKDAYS.length; i += 1) {
    const prev = formatRanges(week[WEEKDAYS[i - 1]!]);
    const current = i < WEEKDAYS.length ? formatRanges(week[WEEKDAYS[i]!]) : null;
    if (current === prev) continue;
    const first = DAY_LABELS[WEEKDAYS[start]!].short;
    const last = DAY_LABELS[WEEKDAYS[i - 1]!].short;
    lines.push({ days: start === i - 1 ? first : `${first}–${last}`, hours: prev });
    start = i;
  }
  return lines;
}

export function describeSpecialDay(day: SpecialDay): string {
  if (day.closed) return "Closed";
  return formatRanges([{ open: day.open ?? "00:00", close: day.close ?? "24:00" }]);
}

/** "Thu, Nov 26, 2026" from YYYY-MM-DD, without a timezone shifting the day. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Reading the forms
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function minutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
}

/** "00:00" as a closing time means the end of the day. */
function closingClock(clock: string): string {
  return clock === "00:00" ? "24:00" : clock;
}

/**
 * Fields: `MONDAY.mode` = `closed` | `open` | `24h`, and for `open`,
 * `MONDAY.0.open`, `MONDAY.0.close`, optionally `MONDAY.1.open` / `.close`.
 */
export function parseHoursForm(formData: FormData): Parsed<WeeklyHours> {
  const week = emptyWeek();
  const errors: string[] = [];

  for (const day of WEEKDAYS) {
    const label = DAY_LABELS[day].long;
    const mode = text(formData, `${day}.mode`);
    if (mode === "closed") continue;
    if (mode === "24h") {
      week[day] = [{ open: "00:00", close: "24:00" }];
      continue;
    }
    if (mode !== "open") {
      errors.push(`${label}: choose open, closed or open 24 hours.`);
      continue;
    }

    const ranges: HoursRange[] = [];
    for (let i = 0; i < MAX_RANGES_PER_DAY; i += 1) {
      const open = text(formData, `${day}.${i}.open`);
      const close = text(formData, `${day}.${i}.close`);
      if (!open && !close) continue;
      if (!CLOCK.test(open) || !CLOCK.test(close)) {
        errors.push(`${label}: enter both an opening and a closing time.`);
        continue;
      }
      if (open === close) {
        errors.push(`${label}: opening and closing times are the same.`);
        continue;
      }
      ranges.push({ open, close: closingClock(close) });
    }
    if (ranges.length === 0) {
      errors.push(`${label}: enter its hours, or mark it closed.`);
      continue;
    }
    if (ranges.length === 2) {
      const [a, b] = ranges.sort((x, y) => minutes(x.open) - minutes(y.open)) as [HoursRange, HoursRange];
      const aEnd = a.close === "24:00" ? 24 * 60 : minutes(a.close);
      if (aEnd <= minutes(a.open) || minutes(b.open) < aEnd) {
        errors.push(`${label}: the two time ranges overlap.`);
        continue;
      }
    }
    week[day] = ranges;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: week };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fields per row `special.N.`: `date`, `mode` = `closed` | `open` | `remove`
 * (or empty for an unused new row), `open`, `close`.
 */
export function parseSpecialHoursForm(formData: FormData, rows: number): Parsed<SpecialDay[]> {
  const days = new Map<string, SpecialDay>();
  const errors: string[] = [];

  for (let i = 0; i < rows; i += 1) {
    const date = text(formData, `special.${i}.date`);
    const mode = text(formData, `special.${i}.mode`);
    if (!date && !mode) continue;
    if (mode === "remove") continue;
    if (!ISO_DAY.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      errors.push(`Row ${i + 1}: pick a date.`);
      continue;
    }
    const label = formatDay(date);
    if (days.has(date)) {
      errors.push(`${label} is listed twice.`);
      continue;
    }
    if (mode === "closed") {
      days.set(date, { date, closed: true });
      continue;
    }
    if (mode !== "open") {
      errors.push(`${label}: choose closed or open.`);
      continue;
    }
    const open = text(formData, `special.${i}.open`);
    const close = text(formData, `special.${i}.close`);
    if (!CLOCK.test(open) || !CLOCK.test(close) || open === close) {
      errors.push(`${label}: enter an opening and a closing time.`);
      continue;
    }
    days.set(date, { date, closed: false, open, close: closingClock(close) });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function weeksEqual(a: WeeklyHours | null, b: WeeklyHours | null): boolean {
  return JSON.stringify(a ?? emptyWeek()) === JSON.stringify(b ?? emptyWeek());
}
