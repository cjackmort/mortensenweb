import { z } from "zod";

/**
 * Reading a site's `src/content/site.json`.
 *
 * The Astro template keeps everything a site says about its business in this
 * one file, so it is what conversion reads to fill General information and to
 * decide whether the client takes bookings or sells things.
 *
 * It is a file in somebody's repository, written by an agent or by hand, so
 * the schema is lenient field by field: a malformed `hours` drops `hours`, not
 * the whole file. Every field is optional because a site built from an older
 * template, or by hand, has whatever it has.
 */

const text = z.string().optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);

function optionalObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).optional().catch(undefined);
}

const SITE_JSON = z.object({
  meta: optionalObject({ businessName: text, tagline: text, domain: text }),
  seo: optionalObject({
    description: text,
    serviceArea: z.array(z.string()).optional().catch(undefined),
  }),
  brand: z.record(z.string(), z.unknown()).optional().catch(undefined),
  contact: optionalObject({
    phone: text,
    email: text,
    address: optionalObject({ street: text, city: text, state: text, zip: text }),
    hours: z.array(z.object({ days: text, open: text, close: text })).optional().catch(undefined),
    social: optionalObject({ facebook: text, instagram: text, google: text }),
  }),
  hero: optionalObject({ secondaryCta: optionalObject({ href: text }) }),
  services: z.array(z.object({ title: text })).optional().catch(undefined),
  analytics: optionalObject({ umamiWebsiteId: text, umamiScriptUrl: text }),
  booking: optionalObject({
    enabled: flag,
    portal: optionalObject({ baseUrl: text, siteId: text }),
  }),
  shop: optionalObject({ enabled: flag, portalBaseUrl: text, siteId: text }),
});

export type SiteJson = z.infer<typeof SITE_JSON>;

export const SITE_JSON_PATH = "src/content/site.json";

export type ParsedSiteJson =
  | { ok: true; site: SiteJson; raw: Record<string, unknown> }
  | { ok: false; message: string };

export function parseSiteJson(source: string): ParsedSiteJson {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, message: `${SITE_JSON_PATH} is not valid JSON.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: `${SITE_JSON_PATH} is not a JSON object.` };
  }
  return { ok: true, site: SITE_JSON.parse(raw), raw: raw as Record<string, unknown> };
}

/**
 * The template's own demo business. A site still carrying it has not been
 * built yet, and none of it may reach a real client's record.
 */
const TEMPLATE_BUSINESS_NAMES = ["acme plumbing & heating"];
const TEMPLATE_DOMAINS = ["acmeplumbing.com"];

export function isTemplateContent(site: SiteJson): boolean {
  const name = site.meta?.businessName?.trim().toLowerCase();
  const domain = site.meta?.domain?.trim().toLowerCase();
  return (
    (name !== undefined && TEMPLATE_BUSINESS_NAMES.includes(name)) ||
    (domain !== undefined && TEMPLATE_DOMAINS.includes(domain))
  );
}

/** Lowercase letters and digits only, without the words names wear loosely. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(the|llc|inc|co|company|ltd)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Whether the file is about this business at all.
 *
 * A concept generated from one of our other sites starts as a copy of that
 * site's `site.json`. Until the build replaces it, it holds another real
 * business's phone number, address and hours — and copying those into this
 * client's General information would put them on this client's site. So the
 * file is only believed when its own name for the business is this one's,
 * allowing for "Basin View Designs" against "Basin View Designs LLC".
 */
export function describesBusiness(site: SiteJson, businessName: string): boolean {
  const theirs = nameKey(site.meta?.businessName ?? "");
  const ours = nameKey(businessName);
  if (!theirs || !ours) return false;
  return theirs.includes(ours) || ours.includes(theirs);
}

/**
 * Values that are obviously not a real business's details: the 555-01xx
 * range reserved for fiction, documentation domains, and the markers people
 * leave when a value is still to come. A placeholder copied into General
 * information would be published by the next agent run as if confirmed.
 */
const PLACEHOLDER = [
  /\b555[-.\s)]*01\d\d\b/,
  /\(555\)/,
  /\bexample\.(com|org|net)\b/i,
  /\bacme\s*plumbing\b/i,
  /\blorem ipsum\b/i,
  /\b(TODO|TBD|TBC|PLACEHOLDER|CLIENT_ID)\b/,
  /\[[^\]]*\]/,
  /x{3,}/i,
];

export function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER.some((pattern) => pattern.test(value));
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `meta.domain` as a bare hostname, when it is one and not a placeholder. */
export function siteDomain(site: SiteJson): string | null {
  const raw = site.meta?.domain?.trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!HOSTNAME.test(host) || looksLikePlaceholder(host) || TEMPLATE_DOMAINS.includes(host)) {
    return null;
  }
  return host;
}

/** Booking and shop as the site declares them; undefined where it says nothing. */
export function kindsFromSiteJson(site: SiteJson): { booking?: boolean; shop?: boolean } {
  return { booking: site.booking?.enabled, shop: site.shop?.enabled };
}
