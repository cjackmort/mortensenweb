import { zonedDayStart } from "@/lib/analytics/filters";
import { businessDate, businessTimezone } from "@/lib/billing/period";

/**
 * Report months, in the business's timezone.
 *
 * A report covers one calendar month as the operator's own calendar has it,
 * the same month boundary the change allowance uses. A UTC month would end at
 * 5pm or 6pm Denver time, so a lead that arrived on the evening of the 31st
 * would be counted in the next month's report and missing from this one.
 *
 * The period is also a URL segment (`/dashboard/reports/2026-09`), so it is
 * validated strictly before anything else touches it.
 */

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Reports are built on the 1st; a later sweep may catch up, but not all month. */
export const CATCH_UP_DAYS = 7;

export interface ReportWindow {
  /** `YYYY-MM`. */
  period: string;
  /** `September 2026`. */
  label: string;
  /** `September`, for "up 18% on August" style comparisons. */
  monthName: string;
  /** `YYYY-MM-DD`, inclusive. */
  firstDay: string;
  lastDay: string;
  /** Midnight on the 1st, business timezone. */
  startAt: Date;
  /** Midnight on the 1st of the next month. Exclusive: half-open like every window here. */
  endAt: Date;
}

export function isPeriod(value: unknown): value is string {
  return typeof value === "string" && PERIOD.test(value);
}

function parts(period: string): [number, number] {
  const match = PERIOD.exec(period);
  if (!match) throw new Error(`Not a report period: ${JSON.stringify(period)}`);
  return [Number(match[1]), Number(match[2])];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function periodOf(year: number, month: number): string {
  return `${pad(year, 4)}-${pad(month)}`;
}

/** The period after `period`. */
export function nextPeriod(period: string): string {
  const [year, month] = parts(period);
  return month === 12 ? periodOf(year + 1, 1) : periodOf(year, month + 1);
}

/** The period before `period`. */
export function previousPeriod(period: string): string {
  const [year, month] = parts(period);
  return month === 1 ? periodOf(year - 1, 12) : periodOf(year, month - 1);
}

export function reportWindow(period: string, timeZone: string = businessTimezone()): ReportWindow {
  const [year, month] = parts(period);
  // Day 0 of next month is the last day of this one, without a table of lengths.
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDay = `${period}-01`;
  const at = new Date(Date.UTC(year, month - 1, 1));

  return {
    period,
    label: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(at),
    monthName: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(at),
    firstDay,
    lastDay: `${period}-${pad(lastDate)}`,
    startAt: new Date(zonedDayStart(firstDay, timeZone)),
    // Midnight on the next 1st rather than the last day plus 24 hours: the
    // two differ by an hour when daylight saving changes inside the month.
    endAt: new Date(zonedDayStart(`${nextPeriod(period)}-01`, timeZone)),
  };
}

/** The period containing `now`, in the business timezone. */
export function currentReportPeriod(now: Date = new Date()): string {
  return businessDate(now).slice(0, 7);
}

/** The month that ended most recently: on 1 October, September. */
export function lastCompletedPeriod(now: Date = new Date()): string {
  return previousPeriod(currentReportPeriod(now));
}

/** Day of the month in the business timezone, 1-31. */
export function businessDayOfMonth(now: Date = new Date()): number {
  return Number(businessDate(now).slice(8, 10));
}

/** Whether `period` has finished, so a report on it says something final. */
export function isCompletedPeriod(period: string, now: Date = new Date()): boolean {
  return reportWindow(period).endAt.getTime() <= now.getTime();
}
