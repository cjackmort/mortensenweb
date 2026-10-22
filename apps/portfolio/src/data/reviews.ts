/**
 * "What clients say" on the home page. An empty list means the section is not
 * on the page at all, which is the default.
 *
 * Only real reviews, copied word for word from where the client posted them,
 * under the name they posted them with. Never a made-up, paraphrased or
 * placeholder review: on a live site that is a false endorsement, which the
 * FTC's rule on reviews and testimonials (16 CFR Part 465) carries penalties for.
 * A review from a relative, an employee, or anyone given something for it
 * needs that connection said next to it — fill in `connection` — or it stays
 * off the site.
 *
 * To add one: open the review on the Google Business Profile, copy the text
 * exactly, and add an entry:
 *
 *   {
 *     author: "Jane Smith",
 *     business: "Smith Plumbing",
 *     rating: 5,
 *     text: "Jack built our site in a week and ...",
 *     date: "2026-09",
 *   },
 */

export interface ClientReview {
  /** The reviewer's name, as it appears on the review. */
  author: string;
  /** Their business, if they want it shown. */
  business?: string;
  /** Stars, as given. */
  rating: 1 | 2 | 3 | 4 | 5;
  /** The review, word for word. Cut only at the end of a sentence, and mark the cut with "…". */
  text: string;
  /** When it was posted, `YYYY-MM`. Google shows "a month ago"; ask the client if unsure. */
  date: string;
  /** Required for a relative, employee or anyone rewarded for the review, e.g. "Jack's father". */
  connection?: string;
}

export const REVIEWS: ClientReview[] = [];

/**
 * The Google Business Profile, for "Read them on Google" under the reviews.
 * Null leaves the link out. Use the profile's own Share link.
 */
export const GOOGLE_REVIEWS_URL: string | null = null;
