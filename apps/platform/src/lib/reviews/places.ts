/**
 * Google's Places API (New), for two things only: helping a business find its
 * own place id at setup, and showing its current rating and review count.
 *
 * Optional. Without `GOOGLE_PLACES_API_KEY` both answer `not_configured`, the
 * setup page falls back to pasting a link, and the rating is simply not shown.
 * A failed call is `failed`, never an empty result — "Google did not answer"
 * and "you have no reviews" must not look the same on the page.
 *
 * Nothing from here is stored except the place id, which Google's terms allow
 * keeping indefinitely. The rating is fetched when the page renders and shown
 * with Google as its source, as the terms also require.
 *
 * Billing: the field masks are kept to what is shown, because Google prices a
 * call by the most expensive field asked for. `rating` and `userRatingCount`
 * are Enterprise-tier fields; see the PR for the current free monthly caps.
 */

const BASE = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export interface FoundPlace {
  placeId: string;
  name: string;
  address: string | null;
}

export interface PlaceSummary {
  placeId: string;
  name: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export type PlacesFailure = { ok: false; reason: "not_configured" | "not_found" | "failed" };

export function placesConfigured(env: Env = process.env): boolean {
  return Boolean(env.GOOGLE_PLACES_API_KEY?.trim());
}

function headers(key: string, fieldMask: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": key,
    "X-Goog-FieldMask": fieldMask,
  };
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
}

export async function searchPlaces(
  query: string,
  { env = process.env, fetch: doFetch = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<{ ok: true; places: FoundPlace[] } | PlacesFailure> {
  const key = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) return { ok: false, reason: "not_configured" };

  try {
    const response = await doFetch(`${BASE}/places:searchText`, {
      method: "POST",
      headers: headers(key, "places.id,places.displayName,places.formattedAddress"),
      body: JSON.stringify({ textQuery: query.slice(0, 200), pageSize: 5 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[reviews] Places search responded ${response.status}`);
      return { ok: false, reason: "failed" };
    }
    const body = (await response.json()) as { places?: RawPlace[] };
    return {
      ok: true,
      places: (body.places ?? [])
        .filter((p): p is RawPlace & { id: string } => typeof p.id === "string")
        .map((p) => ({ placeId: p.id, name: p.displayName?.text ?? p.id, address: p.formattedAddress ?? null })),
    };
  } catch (error) {
    console.warn("[reviews] Places search failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, reason: "failed" };
  }
}

export async function getPlaceSummary(
  placeId: string,
  { env = process.env, fetch: doFetch = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<{ ok: true; place: PlaceSummary } | PlacesFailure> {
  const key = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) return { ok: false, reason: "not_configured" };

  try {
    const response = await doFetch(`${BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: headers(key, "id,displayName,rating,userRatingCount"),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Google answers a malformed or unknown id with 400 or 404.
    if (response.status === 400 || response.status === 404) return { ok: false, reason: "not_found" };
    if (!response.ok) {
      console.warn(`[reviews] Places details responded ${response.status}`);
      return { ok: false, reason: "failed" };
    }
    const body = (await response.json()) as RawPlace;
    return {
      ok: true,
      place: {
        placeId: body.id ?? placeId,
        name: body.displayName?.text ?? null,
        rating: typeof body.rating === "number" ? body.rating : null,
        reviewCount: typeof body.userRatingCount === "number" ? body.userRatingCount : null,
      },
    };
  } catch (error) {
    console.warn("[reviews] Places details failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, reason: "failed" };
  }
}
