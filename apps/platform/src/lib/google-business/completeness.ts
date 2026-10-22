import type { ProfileSnapshot } from "./types";

/**
 * How complete a profile is, as a checklist rather than a score.
 *
 * A percentage invites the question "complete according to whom?", and
 * Google publishes no such figure. Each line here is a concrete thing that is
 * either on the profile or not, with what to do about it — the same list
 * feeds the client's checklist and the operator's "profile gaps" queue.
 *
 * The thresholds (five photos, a post in the last 30 days) are the agency's
 * working standard, not Google's rules, and the copy does not claim otherwise.
 */

export const STALE_POST_DAYS = 30;
export const PHOTO_TARGET = 5;
/** How far ahead a holiday without special hours counts as a gap. */
export const HOLIDAY_LOOKAHEAD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChecklistItem {
  key:
    | "category"
    | "phone"
    | "website"
    | "hours"
    | "description"
    | "photos"
    | "post"
    | "reviews"
    | "holiday";
  label: string;
  done: boolean;
  detail: string;
}

export interface CompletenessInput {
  snapshot: ProfileSnapshot;
  photoCount: number | null;
  lastPostAt: Date | null;
  unansweredReviews: number;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Holidays most local businesses change their hours for (US)
// ---------------------------------------------------------------------------

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The `n`th `weekday` (0 = Sunday) of a month; `n = -1` for the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDate = new Date(Date.UTC(year, month, 0));
  const back = (lastDate.getUTCDay() - weekday + 7) % 7;
  return iso(year, month, lastDate.getUTCDate() - back);
}

export function holidaysIn(year: number): Array<{ date: string; name: string }> {
  return [
    { date: iso(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 5, 1, -1), name: "Memorial Day" },
    { date: iso(year, 7, 4), name: "Independence Day" },
    { date: nthWeekday(year, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekday(year, 11, 4, 4), name: "Thanksgiving" },
    { date: iso(year, 12, 24), name: "Christmas Eve" },
    { date: iso(year, 12, 25), name: "Christmas Day" },
    { date: iso(year, 12, 31), name: "New Year's Eve" },
  ];
}

/** The next holiday within the lookahead that has no special hours set. */
export function nextUnsetHoliday(
  snapshot: ProfileSnapshot,
  now: Date = new Date(),
): { date: string; name: string } | null {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + HOLIDAY_LOOKAHEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
  const set = new Set(snapshot.specialHours.map((d) => d.date));
  const year = now.getUTCFullYear();
  return (
    [...holidaysIn(year), ...holidaysIn(year + 1)]
      .filter((h) => h.date >= today && h.date <= horizon)
      .find((h) => !set.has(h.date)) ?? null
  );
}

// ---------------------------------------------------------------------------

function daysSince(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}

export function profileChecklist(input: CompletenessInput): ChecklistItem[] {
  const now = input.now ?? new Date();
  const { snapshot } = input;
  const holiday = nextUnsetHoliday(snapshot, now);
  const postAge = input.lastPostAt ? daysSince(input.lastPostAt, now) : null;

  return [
    {
      key: "category",
      label: "Business category",
      done: snapshot.primaryCategory !== null,
      detail: snapshot.primaryCategory ?? "No primary category. Google uses it to decide which searches show the profile.",
    },
    {
      key: "phone",
      label: "Phone number",
      done: snapshot.phone !== null,
      detail: snapshot.phone ?? "No phone number, so the Call button does not appear.",
    },
    {
      key: "website",
      label: "Website",
      done: snapshot.website !== null,
      detail: snapshot.website ?? "No website link.",
    },
    {
      key: "hours",
      label: "Opening hours",
      done: snapshot.hours !== null,
      detail: snapshot.hours ? "Set." : "No hours, so Google cannot say whether the business is open.",
    },
    {
      key: "description",
      label: "Description",
      done: snapshot.description !== null,
      detail: snapshot.description
        ? `${snapshot.description.length} of 750 characters.`
        : "No description of what the business does.",
    },
    {
      key: "photos",
      label: `At least ${PHOTO_TARGET} photos`,
      done: (input.photoCount ?? 0) >= PHOTO_TARGET,
      detail:
        input.photoCount === null
          ? "Not counted yet."
          : `${input.photoCount} ${input.photoCount === 1 ? "photo" : "photos"} on the profile.`,
    },
    {
      key: "post",
      label: `A post in the last ${STALE_POST_DAYS} days`,
      done: postAge !== null && postAge <= STALE_POST_DAYS,
      detail:
        postAge === null
          ? "No posts yet."
          : postAge === 0
            ? "Last post today."
            : `Last post ${postAge} ${postAge === 1 ? "day" : "days"} ago.`,
    },
    {
      key: "reviews",
      label: "Every review answered",
      done: input.unansweredReviews === 0,
      detail:
        input.unansweredReviews === 0
          ? "All caught up."
          : `${input.unansweredReviews} ${input.unansweredReviews === 1 ? "review is" : "reviews are"} waiting for a reply.`,
    },
    {
      key: "holiday",
      label: "Holiday hours",
      done: holiday === null,
      detail: holiday ? `No hours set for ${holiday.name} (${holiday.date}).` : "Nothing coming up without hours.",
    },
  ];
}

/** The lines still to do — the operator's "profile gaps". */
export function profileGaps(input: CompletenessInput): ChecklistItem[] {
  return profileChecklist(input).filter((item) => !item.done);
}
