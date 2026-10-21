/**
 * The portal's own shapes for a Google Business Profile.
 *
 * Google's resources are large and change between API versions; these are
 * the parts the portal shows and edits, normalised once in `normalize.ts`.
 * `ProfileSnapshot` is what `google_locations.snapshot` stores, so a field
 * added here is optional — rows written before it existed will not have it.
 */

export const WEEKDAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** "09:00", 24-hour. "24:00" is the end of the day. */
export type ClockTime = string;

export interface HoursRange {
  open: ClockTime;
  close: ClockTime;
}

/** Regular hours: each day's open ranges. A day with no ranges is closed. */
export type WeeklyHours = Record<Weekday, HoursRange[]>;

export interface SpecialDay {
  /** YYYY-MM-DD. */
  date: string;
  closed: boolean;
  /** Present when open; Google allows one range per special day. */
  open?: ClockTime;
  close?: ClockTime;
}

export interface ProfileSnapshot {
  title: string | null;
  phone: string | null;
  website: string | null;
  primaryCategory: string | null;
  additionalCategories: string[];
  description: string | null;
  address: string | null;
  /** Null when Google has no regular hours on the profile at all. */
  hours: WeeklyHours | null;
  specialHours: SpecialDay[];
  /** `OPEN`, `CLOSED_TEMPORARILY`, `CLOSED_PERMANENTLY`. */
  openStatus: string | null;
  mapsUrl: string | null;
  /** Google's own "write a review" link. Review requests send customers here. */
  reviewUrl: string | null;
  placeId: string | null;
  /** Google is holding an edit for review, so what it shows may differ. */
  hasPendingEdits: boolean;
}

export interface GoogleLocationSummary {
  /** `locations/456`. */
  name: string;
  /** `accounts/123`, the account it was listed under. */
  accountName: string;
  title: string;
  address: string | null;
}

export interface GoogleInvitation {
  /** `accounts/123/invitations/abc`. */
  name: string;
  role: string;
  /** What the invitation is for, as Google describes it. */
  target: string;
}

export interface GoogleReview {
  reviewId: string;
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
  postedAt: Date;
  editedAt: Date | null;
  reply: { comment: string; updatedAt: Date | null } | null;
}

export interface ReviewPage {
  reviews: GoogleReview[];
  averageRating: number | null;
  totalReviewCount: number | null;
  nextPageToken: string | null;
}

export const CTA_TYPES = ["LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL"] as const;
export type CtaType = (typeof CTA_TYPES)[number];

export interface PostInput {
  summary: string;
  /** A URL Google can fetch the photo from, once, when the post is created. */
  photoUrl?: string | null;
  cta?: { type: CtaType; url?: string | null } | null;
}

export interface PublishedPost {
  name: string;
  state: string | null;
  searchUrl: string | null;
  createdAt: Date | null;
}

export interface DailyMetricsRow {
  /** YYYY-MM-DD. */
  date: string;
  searchViews: number;
  mapsViews: number;
  calls: number;
  websiteClicks: number;
  directionRequests: number;
}

export interface KeywordCount {
  keyword: string;
  /** Null when Google only says "fewer than `belowThreshold`". */
  impressions: number | null;
  belowThreshold: number | null;
}

export interface DateRange {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  end: string;
}
