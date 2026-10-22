/**
 * The rules an ad's words have to keep, and the check that it claims nothing
 * the business has not told us.
 *
 * The limits are Google's, because Google's are the tightest: a responsive
 * search ad takes headlines of 30 characters and descriptions of 90, and
 * refuses exclamation marks in headlines, phone numbers in the text, and
 * words in capitals for emphasis. Meta accepts all of that and more, so an ad
 * that passes here runs on both.
 */

export const HEADLINE_MAX = 30;
export const DESCRIPTION_MAX = 90;
export const MIN_HEADLINES = 3;
export const MAX_HEADLINES = 5;
export const MIN_DESCRIPTIONS = 2;
export const MAX_DESCRIPTIONS = 2;
export const NAME_MAX = 80;
export const TARGET_AREAS_MAX = 10;

export const CALLS_TO_ACTION = {
  call: "Call now",
  book: "Book now",
  quote: "Get a quote",
  contact: "Contact us",
  learn_more: "Learn more",
} as const;

export type CallToAction = keyof typeof CALLS_TO_ACTION;

export function isCallToAction(value: unknown): value is CallToAction {
  return typeof value === "string" && Object.hasOwn(CALLS_TO_ACTION, value);
}

/** Seven or more digits, with the separators people write numbers with. */
const PHONE_IN_TEXT = /(?:\+?\d[\s().-]*){7,}/;
const SHOUTED_WORD = /\b[A-Z]{5,}\b/;

function isShouted(line: string): boolean {
  if (SHOUTED_WORD.test(line)) return true;
  const words = line.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  return words.length >= 2 && line === line.toUpperCase();
}

function isWebAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Everything that would stop the ad being accepted, in words the client can
 * act on. Empty means it can go to checkout.
 */
export function creativeProblems(input: {
  headlines: string[];
  descriptions: string[];
  finalUrl: string | null;
}): string[] {
  const problems: string[] = [];
  const { headlines, descriptions } = input;

  if (headlines.length < MIN_HEADLINES) problems.push(`Write at least three headlines.`);
  if (headlines.length > MAX_HEADLINES) problems.push(`Use at most ${MAX_HEADLINES} headlines.`);
  if (descriptions.length < MIN_DESCRIPTIONS) problems.push(`Write two descriptions.`);
  if (descriptions.length > MAX_DESCRIPTIONS) problems.push(`Use at most ${MAX_DESCRIPTIONS} descriptions.`);

  headlines.forEach((line, i) => {
    const n = i + 1;
    if (line.length > HEADLINE_MAX) problems.push(`Headline ${n} is over ${HEADLINE_MAX} characters.`);
    if (line.includes("!")) problems.push(`Headline ${n} has an exclamation mark, which Google doesn't allow in headlines.`);
  });

  const seen = new Set<string>();
  for (const line of headlines) {
    const key = line.toLowerCase();
    if (seen.has(key)) problems.push(`Two headlines say "${line}". Each one has to be different.`);
    seen.add(key);
  }

  if (new Set(descriptions.map((d) => d.toLowerCase())).size < descriptions.length) {
    problems.push("The two descriptions are the same. Each one has to be different.");
  }

  descriptions.forEach((line, i) => {
    const n = i + 1;
    if (line.length > DESCRIPTION_MAX) problems.push(`Description ${n} is over ${DESCRIPTION_MAX} characters.`);
    if ((line.match(/!/g) ?? []).length > 1) problems.push(`Description ${n} has more than one exclamation mark.`);
  });

  for (const line of [...headlines, ...descriptions]) {
    if (PHONE_IN_TEXT.test(line)) {
      problems.push(`"${line}" has a phone number in it. Your number goes on the call button instead.`);
    }
    if (/([!?.,])\1/.test(line) && !line.includes("...")) {
      problems.push(`"${line}" repeats punctuation.`);
    }
    if (isShouted(line)) {
      problems.push(`"${line}" uses capitals for emphasis, which Google doesn't allow.`);
    }
  }

  if (!isWebAddress(input.finalUrl)) {
    problems.push("Add the web address people should land on, starting with https://.");
  }

  return problems;
}

/**
 * Claims an ad must not make unless the business has made them first.
 *
 * Each is a pattern for the claim and the word reported for it. The check is
 * deliberately blunt: a word in the ad is fine when the profile uses it too,
 * and flagged otherwise. It catches a client typing "licensed and insured" for
 * a business whose profile never said so, which is the case that matters.
 */
const CLAIMS: Array<{ word: string; pattern: RegExp }> = [
  { word: "licensed", pattern: /\blicen[cs]ed?\b/i },
  { word: "insured", pattern: /\binsured\b|\binsurance\b/i },
  { word: "bonded", pattern: /\bbonded\b/i },
  { word: "certified", pattern: /\bcertifi(?:ed|cation)\b/i },
  { word: "accredited", pattern: /\baccredit/i },
  { word: "award", pattern: /\baward/i },
  { word: "best", pattern: /\bbest\b/i },
  { word: "#1", pattern: /#\s?1\b|\bnumber one\b|\bno\.\s?1\b/i },
  { word: "top-rated", pattern: /\btop[- ]rated\b|\bhighest[- ]rated\b|\b5[- ]star\b|\bfive[- ]star\b/i },
  { word: "guaranteed", pattern: /\bguarant/i },
  { word: "free", pattern: /\bfree\b/i },
  { word: "cheapest", pattern: /\bcheapest\b|\blowest\b/i },
  { word: "fastest", pattern: /\bfastest\b|\bsame[- ]day\b|\b24\/7\b/i },
  { word: "trusted", pattern: /\btrusted\b|\bleading\b/i },
  { word: "years", pattern: /\byears?\b/i },
  { word: "family-owned", pattern: /\bfamily[- ]owned\b/i },
  { word: "discount", pattern: /\bdiscount|\b\d+\s?% off\b|\bsale\b/i },
];

/** Every claim in `text` the profile does not also make, plus unknown numbers. */
export function unsupportedClaims(text: string, profile: Record<string, string>): string[] {
  const facts = Object.values(profile).join("\n");
  const found: string[] = [];

  for (const { word, pattern } of CLAIMS) {
    if (pattern.test(text) && !pattern.test(facts)) found.push(word);
  }

  const factNumbers = new Set(facts.match(/\d+(?:[.,]\d+)?/g) ?? []);
  for (const number of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    if (!factNumbers.has(number) && !found.includes(number)) found.push(number);
  }

  return found;
}

export interface CreativeInput {
  name: string;
  headlines: string[];
  descriptions: string[];
  callToAction: CallToAction | null;
  finalUrl: string | null;
  phone: string | null;
  targetAreas: string[];
  imageAssetPublicId: string | null;
}

function oneLine(value: FormDataEntryValue | null, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Splits "Riverton, South Jordan and Herriman" into its places. */
export function splitAreas(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n/]|\s+(?:and|&)\s+/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, TARGET_AREAS_MAX);
}

/**
 * Read the editor's form. Lengths are not enforced here — an over-long line
 * is kept so the client sees it with the problem beside it, rather than
 * silently cut — but every field is bounded so a pasted essay is not stored.
 */
export function parseCreativeForm(formData: FormData): CreativeInput {
  const lines = (key: string, keep: number) =>
    formData
      .getAll(key)
      .map((value) => oneLine(value, 200))
      .filter(Boolean)
      .slice(0, keep);

  const callToAction = formData.get("callToAction");
  const finalUrl = oneLine(formData.get("finalUrl"), 500);
  const phone = oneLine(formData.get("phone"), 40);
  const image = oneLine(formData.get("imageAssetPublicId"), 64);

  return {
    name: oneLine(formData.get("name"), NAME_MAX),
    headlines: lines("headline", MAX_HEADLINES + 3),
    descriptions: lines("description", MAX_DESCRIPTIONS + 2),
    callToAction: isCallToAction(callToAction) ? callToAction : null,
    finalUrl: finalUrl || null,
    phone: phone || null,
    targetAreas: splitAreas(oneLine(formData.get("targetAreas"), 600)),
    imageAssetPublicId: image || null,
  };
}
