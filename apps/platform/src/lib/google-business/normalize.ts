import {
  WEEKDAYS,
  type ClockTime,
  type DailyMetricsRow,
  type GoogleReview,
  type HoursRange,
  type KeywordCount,
  type ProfileSnapshot,
  type SpecialDay,
  type WeeklyHours,
  type Weekday,
} from "./types";

/**
 * Google's resource shapes, in and out.
 *
 * Proto3 JSON omits zero values, which matters more here than anywhere else in
 * the portal: midnight is `openTime: {}`, a day with no calls has no `value`,
 * and an hour of 0 is simply absent. Every reader below treats a missing
 * number as zero for exactly that reason, and every writer leaves zeros in —
 * Google accepts both.
 */

// ---------------------------------------------------------------------------
// Google's JSON, as far as the portal reads it
// ---------------------------------------------------------------------------

interface GTimeOfDay {
  hours?: number;
  minutes?: number;
}

interface GDate {
  year?: number;
  month?: number;
  day?: number;
}

export interface GTimePeriod {
  openDay?: string;
  openTime?: GTimeOfDay;
  closeDay?: string;
  closeTime?: GTimeOfDay;
}

export interface GSpecialHourPeriod {
  startDate?: GDate;
  endDate?: GDate;
  openTime?: GTimeOfDay;
  closeTime?: GTimeOfDay;
  closed?: boolean;
}

export interface GLocation {
  name?: string;
  title?: string;
  phoneNumbers?: { primaryPhone?: string };
  categories?: {
    primaryCategory?: { displayName?: string };
    additionalCategories?: Array<{ displayName?: string }>;
  };
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
  };
  websiteUri?: string;
  regularHours?: { periods?: GTimePeriod[] };
  specialHours?: { specialHourPeriods?: GSpecialHourPeriod[] };
  profile?: { description?: string };
  openInfo?: { status?: string };
  metadata?: {
    mapsUri?: string;
    newReviewUri?: string;
    placeId?: string;
    hasPendingEdits?: boolean;
  };
}

export interface GReview {
  reviewId?: string;
  name?: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function clockFrom(time: GTimeOfDay | undefined): ClockTime {
  return `${pad(time?.hours ?? 0)}:${pad(time?.minutes ?? 0)}`;
}

export function timeOfDay(clock: ClockTime): GTimeOfDay {
  const [h, m] = clock.split(":").map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
}

function minutesOf(clock: ClockTime): number {
  const [h, m] = clock.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isWeekday(value: string | undefined): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value ?? "");
}

function nextDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 1) % WEEKDAYS.length]!;
}

export function emptyWeek(): WeeklyHours {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, [] as HoursRange[]])) as unknown as WeeklyHours;
}

/**
 * Google's periods → the week. A range past midnight (Fri 18:00 → Sat 02:00)
 * stays on the day it opens, with a close earlier than its open.
 */
export function weekFromPeriods(periods: GTimePeriod[] | undefined): WeeklyHours | null {
  if (!periods || periods.length === 0) return null;
  const week = emptyWeek();
  for (const period of periods) {
    if (!isWeekday(period.openDay)) continue;
    const open = clockFrom(period.openTime);
    let close = clockFrom(period.closeTime);
    // Closing at midnight of the same day reads as 00:00; it means the end of it.
    if (close === "00:00" && period.closeDay === period.openDay) close = "24:00";
    week[period.openDay] = [...week[period.openDay], { open, close }];
  }
  for (const day of WEEKDAYS) {
    week[day] = [...week[day]].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
  }
  return week;
}

/** The week → Google's periods, for a PATCH of `regularHours`. */
export function periodsFromWeek(week: WeeklyHours): GTimePeriod[] {
  const periods: GTimePeriod[] = [];
  for (const day of WEEKDAYS) {
    for (const range of week[day]) {
      const overnight = range.close !== "24:00" && minutesOf(range.close) <= minutesOf(range.open);
      periods.push({
        openDay: day,
        openTime: timeOfDay(range.open),
        closeDay: overnight ? nextDay(day) : day,
        closeTime: timeOfDay(range.close),
      });
    }
  }
  return periods;
}

function isoDate(date: GDate | undefined): string | null {
  if (!date?.year || !date.month || !date.day) return null;
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function gDate(iso: string): GDate {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

export function specialDaysFrom(periods: GSpecialHourPeriod[] | undefined): SpecialDay[] {
  const days: SpecialDay[] = [];
  for (const period of periods ?? []) {
    const date = isoDate(period.startDate);
    if (!date) continue;
    days.push(
      period.closed
        ? { date, closed: true }
        : { date, closed: false, open: clockFrom(period.openTime), close: clockFrom(period.closeTime) },
    );
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export function specialPeriodsFrom(days: SpecialDay[]): GSpecialHourPeriod[] {
  return days.map((day) =>
    day.closed
      ? { startDate: gDate(day.date), endDate: gDate(day.date), closed: true }
      : {
          startDate: gDate(day.date),
          endDate: gDate(day.date),
          openTime: timeOfDay(day.open ?? "00:00"),
          closeTime: timeOfDay(day.close ?? "24:00"),
        },
  );
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function addressOf(address: GLocation["storefrontAddress"]): string | null {
  if (!address) return null;
  const locality = [address.locality, [address.administrativeArea, address.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const parts = [...(address.addressLines ?? []), locality].filter((p) => p && p.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function snapshotFromLocation(location: GLocation): ProfileSnapshot {
  return {
    title: nonEmpty(location.title),
    phone: nonEmpty(location.phoneNumbers?.primaryPhone),
    website: nonEmpty(location.websiteUri),
    primaryCategory: nonEmpty(location.categories?.primaryCategory?.displayName),
    additionalCategories: (location.categories?.additionalCategories ?? [])
      .map((c) => nonEmpty(c.displayName))
      .filter((c): c is string => c !== null),
    description: nonEmpty(location.profile?.description),
    address: addressOf(location.storefrontAddress),
    hours: weekFromPeriods(location.regularHours?.periods),
    specialHours: specialDaysFrom(location.specialHours?.specialHourPeriods),
    openStatus: location.openInfo?.status ?? null,
    mapsUrl: nonEmpty(location.metadata?.mapsUri),
    reviewUrl: nonEmpty(location.metadata?.newReviewUri),
    placeId: nonEmpty(location.metadata?.placeId),
    hasPendingEdits: location.metadata?.hasPendingEdits === true,
  };
}

/**
 * Read a stored snapshot back. `google_locations.snapshot` is JSON written by
 * an earlier version of this code, so anything missing gets its empty value
 * rather than an `undefined` that a page would render as "undefined".
 */
export function readSnapshot(value: unknown): ProfileSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<ProfileSnapshot>;
  return {
    title: v.title ?? null,
    phone: v.phone ?? null,
    website: v.website ?? null,
    primaryCategory: v.primaryCategory ?? null,
    additionalCategories: Array.isArray(v.additionalCategories) ? v.additionalCategories : [],
    description: v.description ?? null,
    address: v.address ?? null,
    hours: v.hours ?? null,
    specialHours: Array.isArray(v.specialHours) ? v.specialHours : [],
    openStatus: v.openStatus ?? null,
    mapsUrl: v.mapsUrl ?? null,
    reviewUrl: v.reviewUrl ?? null,
    placeId: v.placeId ?? null,
    hasPendingEdits: v.hasPendingEdits === true,
  };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function dateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Google appends a machine translation to some review text:
 * "Great work (Translated by Google) ... (Original) ...". The original is
 * what the reviewer wrote, so it is what is kept.
 */
export function originalReviewText(comment: string | undefined): string | null {
  const text = nonEmpty(comment);
  if (!text) return null;
  const original = text.match(/\(Original\)\s*([\s\S]+)$/);
  if (original) return original[1]!.trim();
  return text.replace(/\s*\(Translated by Google\)[\s\S]*$/, "").trim() || null;
}

export function reviewFrom(review: GReview): GoogleReview | null {
  const reviewId = review.reviewId ?? review.name?.split("/").pop();
  const postedAt = dateOrNull(review.createTime);
  if (!reviewId || !postedAt) return null;
  const replyText = nonEmpty(review.reviewReply?.comment);
  return {
    reviewId,
    reviewerName: review.reviewer?.isAnonymous ? null : nonEmpty(review.reviewer?.displayName),
    starRating: STARS[review.starRating ?? ""] ?? null,
    comment: originalReviewText(review.comment),
    postedAt,
    editedAt: dateOrNull(review.updateTime),
    reply: replyText ? { comment: replyText, updatedAt: dateOrNull(review.reviewReply?.updateTime) } : null,
  };
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/** The Performance API's metric names, grouped into the figures the portal shows. */
export const METRIC_FIELDS: Record<string, keyof Omit<DailyMetricsRow, "date">> = {
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "searchViews",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "searchViews",
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "mapsViews",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "mapsViews",
  CALL_CLICKS: "calls",
  WEBSITE_CLICKS: "websiteClicks",
  BUSINESS_DIRECTION_REQUESTS: "directionRequests",
};

export const DAILY_METRICS = Object.keys(METRIC_FIELDS);

interface GMultiDailyResponse {
  multiDailyMetricTimeSeries?: Array<{
    dailyMetricTimeSeries?: Array<{
      dailyMetric?: string;
      timeSeries?: { datedValues?: Array<{ date?: GDate; value?: string }> };
    }>;
  }>;
}

/**
 * One row per day Google reported on, with every figure present — Google
 * omits zeros, and a day it reported with nothing on it is a real zero.
 */
export function dailyRowsFrom(response: GMultiDailyResponse): DailyMetricsRow[] {
  const byDate = new Map<string, DailyMetricsRow>();
  for (const group of response.multiDailyMetricTimeSeries ?? []) {
    for (const series of group.dailyMetricTimeSeries ?? []) {
      const field = METRIC_FIELDS[series.dailyMetric ?? ""];
      if (!field) continue;
      for (const point of series.timeSeries?.datedValues ?? []) {
        const date = isoDate(point.date);
        if (!date) continue;
        const row =
          byDate.get(date) ??
          { date, searchViews: 0, mapsViews: 0, calls: 0, websiteClicks: 0, directionRequests: 0 };
        const value = Number(point.value ?? 0);
        byDate.set(date, { ...row, [field]: row[field] + (Number.isFinite(value) ? value : 0) });
      }
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

interface GKeywordResponse {
  searchKeywordsCounts?: Array<{
    searchKeyword?: string;
    insightsValue?: { value?: string; threshold?: string };
  }>;
  nextPageToken?: string;
}

export function keywordCountsFrom(response: GKeywordResponse): KeywordCount[] {
  const counts: KeywordCount[] = [];
  for (const row of response.searchKeywordsCounts ?? []) {
    const keyword = nonEmpty(row.searchKeyword);
    if (!keyword) continue;
    const value = row.insightsValue?.value;
    const threshold = row.insightsValue?.threshold;
    if (value !== undefined) counts.push({ keyword, impressions: Number(value), belowThreshold: null });
    else if (threshold !== undefined) counts.push({ keyword, impressions: null, belowThreshold: Number(threshold) });
  }
  return counts;
}
