/**
 * A first draft of a reply to a Google review, for the operator to approve.
 *
 * Built from the review and the business's own details — nothing else. That
 * rule is the whole design. A reply is published under the business's name on
 * Google, where it stays, so a draft must never say anything that is not
 * already true: no promised refunds, no "our 20 years of experience", no
 * staff names, no details of a complaint the reviewer did not give. What it
 * may use is the reviewer's first name, the rating, the services the review
 * actually mentions (matched against the business's own service list), and
 * the business's public phone or email for an unhappy customer to reach.
 *
 * Deterministic, and no model call: the portal does not call an LLM API
 * (agent work goes through GitHub Actions), and a template the operator can
 * read is easier to trust here than prose that changes on every refresh. The
 * phrasing varies by review so a run of five-star replies does not read as
 * one sentence pasted ten times. `ReplyDrafter` is the seam to swap in
 * something smarter later; every draft still waits for a person either way.
 */

export interface DraftInput {
  reviewId: string;
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
}

export interface BusinessVoice {
  name: string | null;
  phone: string | null;
  email: string | null;
  /** The business's service list, one per entry; prices after a dash are ignored. */
  services: string[];
}

export type ReplyDrafter = (review: DraftInput, business: BusinessVoice) => string;

/** Google's limit on a reply. Drafts stay far below it. */
export const REPLY_MAX = 4096;

const NUMBER_WORDS = ["", "one", "two", "three", "four", "five"];

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

function pick<T>(options: readonly T[], seed: string, salt: string): T {
  return options[hash(seed + salt) % options.length]!;
}

/**
 * The reviewer's first name, when Google gave a real one. "A Google User",
 * initials and handles come back null, and the draft says no name at all.
 */
export function firstName(displayName: string | null): string | null {
  if (!displayName) return null;
  if (/^a google user$/i.test(displayName.trim())) return null;
  const first = displayName.trim().split(/\s+/)[0] ?? "";
  if (!/^[\p{L}][\p{L}'’-]+$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** "Water heater installs – from $1,200" → "water heater installs". */
function serviceName(line: string): string {
  return line.split(/\s[–—-]\s|:/)[0]!.trim().replace(/[.]+$/, "");
}

/** The first of the business's services the review mentions by name. */
export function mentionedService(comment: string | null, services: string[]): string | null {
  if (!comment) return null;
  const text = comment.toLowerCase();
  for (const line of services) {
    const name = serviceName(line);
    if (name.length < 3) continue;
    const lower = name.toLowerCase();
    // Whole words, so "roof" does not match "proof".
    const pattern = new RegExp(`(^|[^\\p{L}])${lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?([^\\p{L}]|$)`, "u");
    if (pattern.test(text)) return lower;
  }
  return null;
}

function contactLine(business: BusinessVoice): string {
  if (business.phone) return `please call us at ${business.phone}`;
  if (business.email) return `please email us at ${business.email}`;
  return "please get in touch with us directly";
}

function signOff(business: BusinessVoice): string {
  return business.name ? `\n\n— ${business.name}` : "";
}

export const draftReviewReply: ReplyDrafter = (review, business) => {
  const seed = review.reviewId;
  const name = firstName(review.reviewerName);
  const stars = review.starRating;
  const service = mentionedService(review.comment, business.services);
  const hasComment = Boolean(review.comment && review.comment.trim());

  // Unrated reviews are treated as neutral: thanks, and a way to reach us.
  if (stars !== null && stars <= 2) {
    const opener = name
      ? pick([`${name}, we're sorry to read this.`, `${name}, thank you for telling us, and we're sorry.`], seed, "o")
      : pick(["We're sorry to read this.", "Thank you for telling us, and we're sorry."], seed, "o");
    return [
      opener,
      "It isn't the experience we want anyone to have.",
      `So we can understand what happened and try to put it right, ${contactLine(business)}.`,
    ].join(" ") + signOff(business);
  }

  if (stars === null || stars === 3) {
    const opener = name ? `Thank you for the feedback, ${name}.` : "Thank you for the feedback.";
    return [
      opener,
      `We'd like to hear what would have made it better — ${contactLine(business)}.`,
    ].join(" ") + signOff(business);
  }

  const opener = name
    ? pick([`Thank you, ${name}!`, `Thanks so much, ${name}!`, `${name}, thank you!`], seed, "o")
    : pick(["Thank you!", "Thanks so much!", "Thank you for this!"], seed, "o");

  const middle = service
    ? pick(
        [`We're glad the ${service} went well.`, `Glad to hear you were happy with the ${service}.`],
        seed,
        "m",
      )
    : hasComment
      ? pick(
          ["We appreciate you taking the time to write this.", "It means a lot that you took the time to write this."],
          seed,
          "m",
        )
      : `We appreciate the ${NUMBER_WORDS[stars]}-star rating.`;

  const closer =
    stars === 4
      ? "If there's anything we could have done better, we'd like to hear it."
      : pick(
          [
            // "Riverton Plumbing Co." already ends the sentence.
            business.name ? `Thanks for choosing ${business.name.replace(/\.$/, "")}.` : "Thanks for choosing us.",
            "We hope to see you again.",
          ],
          seed,
          "c",
        );

  return [opener, middle, closer].join(" ") + signOff(business);
};

/** The business's services from its General information, one per line. */
export function servicesFrom(servicesField: string | undefined | null): string[] {
  return (servicesField ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}
