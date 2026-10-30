import type { TimeRange } from "./slots";
import type { IsoDate } from "./time";

/**
 * Times as a client and their customers read them: always in the business's
 * zone, because that is where the appointment happens — a customer booking
 * from another state still turns up at 9 AM Denver time.
 */

/** `540` → `9:00 AM`; `1440` → `midnight`. */
export function formatClock(minutes: number): string {
  if (minutes === 0 || minutes === 1440) return "midnight";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** `9:00 AM – 5:00 PM`. */
export function formatRange(range: TimeRange): string {
  return `${formatClock(range.start)} – ${formatClock(range.end)}`;
}

/** `9:00 AM`, in the zone. */
export function formatSlotTime(instant: Date, timeZone: string): string {
  return instant.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

/**
 * `Thu, Oct 30` for a calendar date. Formatted in UTC on purpose: a date is a
 * day, not an instant, and shifting midnight UTC into Denver prints the day
 * before.
 */
export function formatDay(date: IsoDate, style: "short" | "long" = "short"): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: style,
    month: style,
    day: "numeric",
    ...(style === "long" ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  });
}

/** `Thursday, October 30, 2026 at 9:00 AM MDT` — for emails, where the zone must be said. */
export function formatAppointment(instant: Date, timeZone: string): string {
  const day = instant.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const time = instant.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone });
  return `${day} at ${time}`;
}

/** `Mountain Time`. Falls back to the IANA name where the runtime has no generic name. */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** `0` → `None`, `120` → `2 hours`, `1440` → `1 day`, `10080` → `1 week`. */
export function formatDuration(minutes: number): string {
  if (minutes === 0) return "None";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % 10080 === 0) return plural(minutes / 10080, "week");
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  if (minutes > 60) return `${plural(Math.floor(minutes / 60), "hour")} ${plural(minutes % 60, "minute")}`;
  return plural(minutes, "minute");
}
