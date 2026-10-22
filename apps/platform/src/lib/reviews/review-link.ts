/**
 * The Google "write a review" link a business sends its customers.
 *
 * Two forms are accepted, because they are the two a business can actually get
 * hold of:
 *
 *  - **A place id**, bare or inside a `search.google.com/local/writereview`
 *    link. Google documents building the review link from it, and it is also
 *    what the Places API returns, so the portal can look the business up.
 *  - **A `g.page/r/…/review` short link**, which is what Google Business
 *    Profile's own "Ask for reviews" button hands out. It has no place id in
 *    it, so there is nothing to keep but the link.
 *
 * A Google Maps listing link is the commonest wrong paste: it opens the
 * business, not the review form, so customers would have to find the button
 * themselves. It is refused with a message that says where the right link is.
 *
 * Anything else is refused. The stored link is where every customer of the
 * business is redirected from a portal URL, so an arbitrary address here would
 * turn the portal into an open redirect wearing the business's name.
 */

export type ReviewLinkResult =
  | { ok: true; placeId: string | null; reviewUrl: string }
  | { ok: false; message: string };

/** Google place ids are URL-safe base64-ish strings; the shortest seen are ~20 characters. */
const PLACE_ID = /^[A-Za-z0-9_-]{16,300}$/;
/** The code in a `g.page/r/<code>/review` link. */
const SHORT_CODE = /^[A-Za-z0-9_-]{6,100}$/;

const NOT_A_REVIEW_LINK =
  "That is a link to your Google listing, not the review form. In your Google Business Profile, choose \"Ask for reviews\" and paste that link instead.";
const UNRECOGNISED =
  "Paste the link from \"Ask for reviews\" in your Google Business Profile, or your Google place ID.";

export function reviewUrlForPlace(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}

export function parseReviewLink(raw: string): ReviewLinkResult {
  const input = raw.trim();
  if (!input) return { ok: false, message: UNRECOGNISED };

  if (!input.includes("/") && !input.includes(".")) {
    return PLACE_ID.test(input)
      ? { ok: true, placeId: input, reviewUrl: reviewUrlForPlace(input) }
      : { ok: false, message: UNRECOGNISED };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, message: UNRECOGNISED };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: UNRECOGNISED };

  const host = url.hostname.toLowerCase();

  if (host === "search.google.com" && url.pathname === "/local/writereview") {
    const placeId = url.searchParams.get("placeid");
    return placeId && PLACE_ID.test(placeId)
      ? { ok: true, placeId, reviewUrl: reviewUrlForPlace(placeId) }
      : { ok: false, message: UNRECOGNISED };
  }

  if (host === "g.page") {
    const match = url.pathname.match(/^\/r\/([^/]+)\/review\/?$/);
    return match && SHORT_CODE.test(match[1]!)
      ? { ok: true, placeId: null, reviewUrl: `https://g.page/r/${match[1]}/review` }
      : { ok: false, message: UNRECOGNISED };
  }

  const isMaps =
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "maps.google.com" ||
    ((host === "www.google.com" || host === "google.com") && url.pathname.startsWith("/maps"));
  return { ok: false, message: isMaps ? NOT_A_REVIEW_LINK : UNRECOGNISED };
}
