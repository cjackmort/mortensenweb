import { reviewStatsSource, type LinkedProfileStats } from "@/lib/reviews/stats";

/**
 * The business's current Google rating, when there is a source for it: the
 * linked Business Profile's synced copy first, then the Places API.
 *
 * Rendered inside a Suspense boundary so a slow answer from Google never holds
 * up the page. No source (no synced profile, no place id, or the Places API
 * not switched on) renders nothing at all; a failed call says so, rather than
 * showing a zero that would read as "you have no reviews".
 */
export async function GoogleRating({
  placeId,
  linkedProfile,
}: {
  placeId: string | null;
  linkedProfile: LinkedProfileStats;
}) {
  const result = await reviewStatsSource({ linkedProfile })({ placeId });
  if (!result.ok) {
    return result.reason === "failed" ? (
      <p className="hint review-rating">We couldn&rsquo;t reach Google for your rating just now.</p>
    ) : null;
  }

  const { rating, reviewCount, source } = result.stats;
  if (rating === null && reviewCount === null) return null;
  return (
    <p className="review-rating">
      {rating !== null && (
        <span className="review-rating-figure">
          {rating.toFixed(1)} <span aria-hidden="true">★</span>
          <span className="sr-only"> out of 5</span>
        </span>
      )}
      {reviewCount !== null && (
        <span>
          {reviewCount.toLocaleString("en-US")} {reviewCount === 1 ? "review" : "reviews"} on Google
        </span>
      )}
      <span className="hint">Source: {source}</span>
    </p>
  );
}
