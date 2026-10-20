import type { BusinessDetails } from "@/lib/business-profile";
import {
  DESCRIPTION_MAX,
  HEADLINE_MAX,
  MAX_HEADLINES,
  MIN_HEADLINES,
  splitAreas,
  type CallToAction,
} from "./creative";

/**
 * A first draft of an ad, written from the business profile alone.
 *
 * Template-based on purpose. Every line is assembled from a profile field, so
 * every claim in a draft traces to something the business told us — the one
 * property an ad written on a real business's behalf must have, and the one a
 * language model cannot promise. It also means the draft exists the moment
 * the client presses the button, inside the action's time budget, with no
 * second vendor or key involved. The client edits everything before paying;
 * the draft only has to be a sound, true starting point.
 *
 * Phone numbers never go in the text: Google refuses them there. The number
 * rides on the call button instead.
 */

export interface DraftImage {
  publicId: string;
  title: string | null;
  width: number | null;
  height: number | null;
}

export interface AdDraft {
  name: string;
  headlines: string[];
  descriptions: string[];
  callToAction: CallToAction;
  finalUrl: string | null;
  phone: string | null;
  imageAssetPublicId: string | null;
  targetAreas: string[];
  /** The profile fields the draft was written from, copied onto the campaign. */
  facts: Record<string, string>;
  /** Profile fields that would have made a better draft. */
  missing: string[];
}

const USED_FIELDS = ["businessName", "tagline", "services", "serviceArea", "phone", "website", "bookingUrl"] as const;

const SMALL_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "with", "&"]);

/** "drain cleaning" → "Drain Cleaning"; leaves "HVAC" and "iPhone" alone. */
function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word, i) => {
      if (i > 0 && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      if (/[A-Z]/.test(word.slice(1))) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Shorten at a word boundary, dropping a dangling "and" or comma, so a long
 * business name becomes "Acme Plumbing, Heating" rather than "Acme Plumbing, He".
 */
function fit(text: string, max: number): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean || null;

  const words = clean.split(" ");
  while (words.length > 1) {
    words.pop();
    while (words.length > 1 && SMALL_WORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
    const candidate = words.join(" ").replace(/[,;:–—-]+$/, "").trim();
    if (candidate.length <= max) return candidate;
  }
  return null;
}

/** One service per line; a price after a dash and a leading bullet are dropped. */
export function parseServices(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[\s•*·-]+/, "")
        .replace(/\s+[-–—:]\s+.*$/, "")
        .replace(/\s+\(?\$.*$/, "")
        .trim(),
    )
    .filter(Boolean);
}

export const parseServiceAreas = splitAreas;

/** "A, B and C" */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The longest "services in areas" sentence that fits, dropping from the end. */
function servicesSentence(services: string[], areas: string[]): string | null {
  for (let s = Math.min(services.length, 4); s >= 1; s--) {
    for (let a = Math.min(areas.length, 3); a >= 0; a--) {
      const what = listOf(services.slice(0, s).map((x, i) => (i === 0 ? x : x.toLowerCase())));
      const where = a > 0 ? ` in ${listOf(areas.slice(0, a))}` : "";
      const line = sentence(`${what}${where}`);
      if (line.length <= DESCRIPTION_MAX) return line;
    }
  }
  return null;
}

function ctaHeadline(cta: CallToAction): string {
  if (cta === "call") return "Call Today";
  if (cta === "book") return "Book Online";
  return "Visit Our Website";
}

function ctaSentence(cta: CallToAction, name: string): string {
  if (cta === "call") return fit(`Call ${name} today.`, DESCRIPTION_MAX) ?? "Call us today.";
  if (cta === "book") return fit(`Book online with ${name}.`, DESCRIPTION_MAX) ?? "Book online today.";
  return fit(`Visit ${name} online to find out more.`, DESCRIPTION_MAX) ?? "Visit us online to find out more.";
}

function pickImage(images: DraftImage[]): string | null {
  const scored = images
    .filter((img) => img.width && img.height)
    .map((img) => ({ img, landscape: img.width! >= img.height!, area: img.width! * img.height! }))
    .sort((a, b) => Number(b.landscape) - Number(a.landscape) || b.area - a.area);
  return scored[0]?.img.publicId ?? images[0]?.publicId ?? null;
}

export function draftAd(input: {
  profile: BusinessDetails;
  organizationName: string;
  /** The live site the portal manages, when there is one. */
  siteUrl: string | null;
  images: DraftImage[];
}): AdDraft {
  const { profile } = input;
  const businessName = profile.businessName?.trim() || input.organizationName.trim();
  const services = parseServices(profile.services);
  const areas = parseServiceAreas(profile.serviceArea);
  const city = areas[0];

  const callToAction: CallToAction = profile.bookingUrl ? "book" : profile.phone ? "call" : "learn_more";

  // ---- headlines, best first ---------------------------------------------
  const candidates: Array<string | null> = [fit(businessName, HEADLINE_MAX)];
  for (const service of services.slice(0, 2)) {
    const titled = titleCase(service);
    const local = city ? `${titled} in ${city}` : null;
    candidates.push(local && local.length <= HEADLINE_MAX ? local : fit(titled, HEADLINE_MAX));
  }
  if (city) {
    const twoAreas = areas.length > 1 ? `Serving ${areas[0]} & ${areas[1]}` : null;
    candidates.push(twoAreas && twoAreas.length <= HEADLINE_MAX ? twoAreas : fit(`Serving ${city}`, HEADLINE_MAX));
  }
  if (profile.tagline) candidates.push(profile.tagline.length <= HEADLINE_MAX ? profile.tagline.trim() : null);
  candidates.push(ctaHeadline(callToAction));
  // Generic, claim-free filler for a profile too thin to reach three.
  candidates.push("Get in Touch", "Contact Us Today");

  const headlines: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (headlines.some((h) => h.toLowerCase() === candidate.toLowerCase())) continue;
    headlines.push(candidate);
  }
  // Filler only to reach the minimum, never to pad a good draft.
  const real = headlines.filter((h) => h !== "Get in Touch" && h !== "Contact Us Today");
  const chosen = (real.length >= MIN_HEADLINES ? real : headlines).slice(0, MAX_HEADLINES);

  // ---- descriptions ------------------------------------------------------
  const tagline = profile.tagline ? sentence(profile.tagline.trim()) : null;
  const offer = servicesSentence(services, areas);
  const descriptions = [
    tagline && tagline.length <= DESCRIPTION_MAX ? tagline : offer,
    tagline && tagline.length <= DESCRIPTION_MAX ? offer : null,
  ].filter((line): line is string => Boolean(line));
  // Fallbacks for a thin profile, in order, each different: Google refuses
  // an ad whose two descriptions are the same.
  const fallbacks = [
    city ? fit(sentence(`${businessName}, serving ${listOf(areas.slice(0, 3))}`), DESCRIPTION_MAX) : null,
    ctaSentence(callToAction, businessName),
    fit(`Find out more about ${businessName}.`, DESCRIPTION_MAX) ?? "Find out more about us.",
  ];
  for (const line of fallbacks) {
    if (descriptions.length >= 2) break;
    if (line && !descriptions.some((d) => d.toLowerCase() === line.toLowerCase())) descriptions.push(line);
  }

  const facts: Record<string, string> = {};
  for (const key of USED_FIELDS) if (profile[key]) facts[key] = profile[key]!;
  if (!profile.businessName) facts.businessName = businessName;

  const missing = (["businessName", "services", "serviceArea", "phone", "website"] as const).filter(
    (key) => !profile[key],
  );

  return {
    name: fit(`${services[0] ? titleCase(services[0]) : businessName} ad`, 80)!,
    headlines: chosen,
    descriptions: descriptions.slice(0, 2),
    callToAction,
    finalUrl: input.siteUrl ?? profile.website ?? null,
    phone: profile.phone ?? null,
    imageAssetPublicId: pickImage(input.images),
    targetAreas: areas,
    facts,
    missing,
  };
}
