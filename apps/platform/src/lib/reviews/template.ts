import { firstName } from "./contact";

/**
 * The words of a review request, which the business can make its own.
 *
 * What the business cannot edit is the part that makes it a review request:
 * the button to Google and the unsubscribe line are added around the template,
 * never written into it, so no edit can drop the link or the way out.
 *
 * ## No review gating, no incentives
 *
 * Google removes reviews, and can suspend a profile, when a business asks only
 * its happy customers ("review gating"), steers unhappy ones somewhere else
 * first, asks for a particular star rating, or offers anything in return. The
 * FTC's 2024 rule on reviews says the same about incentives. A template that
 * does any of that is refused here, with the reason, rather than sent in the
 * business's name. The patterns are deliberately the unmistakable ones:
 * "we're happy we could help" is fine; "if you were happy, review us" is not.
 */

export interface ReviewTemplate {
  subject: string;
  body: string;
  reminderBody: string;
}

export const DEFAULT_TEMPLATE: ReviewTemplate = {
  subject: "Would you leave {business} a review?",
  body: [
    "Hi {first_name},",
    "",
    "Thank you for choosing {business}. If you have a minute, an honest review on Google would help us a lot. It is how people nearby find us.",
    "",
    "Thank you,",
    "{business}",
  ].join("\n"),
  reminderBody: [
    "Hi {first_name},",
    "",
    "Just a reminder in case our last email got buried. If you have a minute, an honest review on Google would mean a lot to us.",
    "",
    "Thank you,",
    "{business}",
  ].join("\n"),
};

export const PLACEHOLDERS = ["first_name", "name", "business"] as const;
export const MAX_SUBJECT_LENGTH = 120;
export const MAX_BODY_LENGTH = 2000;

const GATING: RegExp[] = [
  // "5 stars", "five-star review", "5★"
  /\b(?:5|five)[\s-]*stars?\b/i,
  /\b5\s*★/,
  // "if you were happy…", "if you're satisfied…", "if you enjoyed…"
  /\bif\s+(?:you(?:'|’)re|you\s+(?:were|are|felt|feel)|you)\s+(?:\w+\s+)?(?:happy|satisfied|pleased|delighted|enjoyed|loved|liked|impressed)\b/i,
  // "Not happy? Call us first", "if anything wasn't right…"
  /\b(?:not|un)\s*happy\b/i,
  /\b(?:dis|not\s+|un)satisfied\b/i,
  /\b(?:wasn|weren)(?:'|’)?t\s+(?:happy|satisfied|right|perfect)\b/i,
];

const INCENTIVES: RegExp[] = [
  /\b(?:discount|coupon|voucher|gift\s*cards?|rebate|reward|prize|giveaway|raffle)s?\b/i,
  /\d+\s*%\s*off\b/i,
  /\bpercent\s+off\b/i,
  /\benter(?:ed)?\s+(?:to\s+win|in(?:to)?\s+a\s+(?:draw|drawing|raffle)|a\s+(?:draw|drawing|raffle))\b/i,
  /\bfree\s+(?:gift|month|service|cleaning|visit|item|product)s?\b/i,
];

const GATING_MESSAGE =
  "Google does not allow asking only happy customers, steering unhappy ones elsewhere, or asking for a star rating. Ask every customer for an honest review.";
const INCENTIVE_MESSAGE =
  "Google does not allow offering anything in return for a review. Ask every customer for an honest review.";

export function renderTemplate(text: string, values: { name: string; business: string }): string {
  return text
    .replace(/\{first_name\}/g, firstName(values.name))
    .replace(/\{name\}/g, values.name.trim())
    .replace(/\{business\}/g, values.business);
}

export type TemplateCheck = { ok: true } | { ok: false; message: string };

export function validateTemplate(template: ReviewTemplate): TemplateCheck {
  const fields: [string, string, number][] = [
    ["subject", template.subject, MAX_SUBJECT_LENGTH],
    ["message", template.body, MAX_BODY_LENGTH],
    ["reminder", template.reminderBody, MAX_BODY_LENGTH],
  ];

  for (const [label, value, max] of fields) {
    if (!value.trim()) return { ok: false, message: `Write a ${label} first.` };
    if (value.length > max) return { ok: false, message: `Keep the ${label} under ${max} characters.` };

    for (const [, inner] of value.matchAll(/\{([^{}]*)\}/g)) {
      if (!(PLACEHOLDERS as readonly string[]).includes(inner!)) {
        return {
          ok: false,
          message: `{${inner}} is not something we can fill in. Use {first_name}, {name} or {business}.`,
        };
      }
    }

    if (GATING.some((pattern) => pattern.test(value))) return { ok: false, message: GATING_MESSAGE };
    if (INCENTIVES.some((pattern) => pattern.test(value))) return { ok: false, message: INCENTIVE_MESSAGE };
  }

  return { ok: true };
}

/** The business's saved template with the default filling whatever they never changed. */
export function effectiveTemplate(saved: {
  emailSubject: string | null;
  emailBody: string | null;
  reminderBody: string | null;
}): ReviewTemplate {
  return {
    subject: saved.emailSubject ?? DEFAULT_TEMPLATE.subject,
    body: saved.emailBody ?? DEFAULT_TEMPLATE.body,
    reminderBody: saved.reminderBody ?? DEFAULT_TEMPLATE.reminderBody,
  };
}
