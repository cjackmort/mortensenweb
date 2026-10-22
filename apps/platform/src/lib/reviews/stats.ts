import { getPlaceSummary } from "./places";

/**
 * Where a business's Google rating and review count come from — a seam, so
 * the source can change without touching the page.
 *
 * Today the only source is the Places API, behind `GOOGLE_PLACES_API_KEY`: a
 * current rating and count, no history. The Google profile management feature
 * (`lib/google-business`, branch `feat/google-profile`) will be able to supply
 * reviews over time once Google approves Business Profile API access for the
 * portal; when it can, it implements `ReviewStatsSource` with `history` filled
 * in and `reviewStatsSource()` prefers it for businesses with a linked
 * profile. Until then a business without a place id, or without the key set,
 * gets `unavailable` and the page shows nothing — never a guessed figure.
 */

export interface ReviewStats {
  rating: number | null;
  reviewCount: number | null;
  /** Shown beside the figures, as Google's terms require. */
  source: "Google Maps" | "Google Business Profile";
  /** Counts over time, when the source has them. Places does not. */
  history?: Array<{ date: string; reviewCount: number; rating: number | null }>;
}

export type ReviewStatsResult =
  | { ok: true; stats: ReviewStats }
  | { ok: false; reason: "unavailable" | "failed" };

export type ReviewStatsSource = (business: { placeId: string | null }) => Promise<ReviewStatsResult>;

export const placesReviewStats: ReviewStatsSource = async ({ placeId }) => {
  if (!placeId) return { ok: false, reason: "unavailable" };
  const result = await getPlaceSummary(placeId);
  if (!result.ok) return { ok: false, reason: result.reason === "failed" ? "failed" : "unavailable" };
  return {
    ok: true,
    stats: { rating: result.place.rating, reviewCount: result.place.reviewCount, source: "Google Maps" },
  };
};

export function reviewStatsSource(): ReviewStatsSource {
  return placesReviewStats;
}
