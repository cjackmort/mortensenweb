import { getPlaceSummary } from "./places";

/**
 * Where a business's Google rating and review count come from — a seam, so
 * the source can change without touching the page.
 *
 * Two sources, in order:
 *
 *  1. **The linked Google Business Profile**, for a business whose profile the
 *     agency manages: the portal's own copy, synced every six hours
 *     (`getGoogleReviewStats` in `db/repositories/client/google-profile.ts`).
 *     It costs no API call when the page renders.
 *  2. **The Places API**, behind `GOOGLE_PLACES_API_KEY`: a current rating and
 *     count from the business's place id, no history.
 *
 * A profile that is linked but has not synced yet — the state of every
 * profile while Google has not approved Business Profile API access — or that
 * synced without a rating or a count, falls through to Places rather than
 * hiding a figure Places has. A business with neither gets `unavailable` and
 * the page shows nothing: never a guessed figure.
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

/** The business's linked profile, already scoped to it by the caller. */
export type LinkedProfileStats = () => Promise<ReviewStatsResult>;

export const placesReviewStats: ReviewStatsSource = async ({ placeId }) => {
  if (!placeId) return { ok: false, reason: "unavailable" };
  const result = await getPlaceSummary(placeId);
  if (!result.ok) return { ok: false, reason: result.reason === "failed" ? "failed" : "unavailable" };
  return {
    ok: true,
    stats: { rating: result.place.rating, reviewCount: result.place.reviewCount, source: "Google Maps" },
  };
};

function hasFigures(stats: ReviewStats): boolean {
  return stats.rating !== null || stats.reviewCount !== null;
}

export function reviewStatsSource({
  linkedProfile,
  places = placesReviewStats,
}: { linkedProfile?: LinkedProfileStats; places?: ReviewStatsSource } = {}): ReviewStatsSource {
  return async (business) => {
    if (linkedProfile) {
      const fromProfile = await linkedProfile();
      if (fromProfile.ok && hasFigures(fromProfile.stats)) return fromProfile;
    }
    return places(business);
  };
}
