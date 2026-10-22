import type { CampaignPlacement } from "@/db/schema/campaigns";

/**
 * Everything about a campaign that ends up printed or in a URL.
 *
 * ## The rule that matters
 *
 * **A short link only ever sends people to the client's own site.** The
 * destination is stored as a path, the origin comes from the site row the
 * operator set up, and `destinationUrl` re-checks the origin after joining
 * the two. Without that, a campaign would be an open redirect carrying the
 * client's name — exactly what a phishing message would want to borrow.
 */

export const PLACEMENT_LABELS: Record<CampaignPlacement, string> = {
  door_hangers: "Door hangers",
  flyers: "Flyers",
  yard_signs: "Yard signs",
  truck: "Truck or van",
  business_cards: "Business cards",
  other: "Something else",
};

/** `utm_source`. Hyphens, because analytics tools show it as typed. */
export function placementSource(placement: CampaignPlacement): string {
  return placement.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * No 0/o, 1/l/i: a code is read off a sign from across a street and typed
 * into a phone by someone who cannot scan it.
 */
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 6;
/** The largest multiple of the alphabet below 256, so every symbol is equally likely. */
const UNBIASED_BYTE_LIMIT = 256 - (256 % CODE_ALPHABET.length);
const CODE_PATTERN = /^[a-z0-9]{4,16}$/;

/** A new code. Collisions are caught by the unique index and retried by the caller. */
export function newCampaignCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** A code as typed, or null when it cannot be one — checked before any query. */
export function normaliseCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// The client's site
// ---------------------------------------------------------------------------

/** Where the site serves, as an origin, or null when it has no address yet. */
export function siteOrigin(site: { productionUrl: string | null; primaryDomain: string | null }): string | null {
  for (const candidate of [site.productionUrl, site.primaryDomain]) {
    const origin = originOf(candidate);
    if (origin) return origin;
  }
  return null;
}

function originOf(raw: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function sameSite(host: string, origin: string): boolean {
  const own = new URL(origin).hostname.replace(/^www\./, "");
  return host.replace(/^www\./, "") === own;
}

const MAX_PATH_LENGTH = 300;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

export type DestinationResult = { ok: true; path: string } | { ok: false; message: string };

const NOT_YOURS: DestinationResult = {
  ok: false,
  message: "Pick a page on your own website, such as /services or /contact.",
};

/**
 * Read the destination a client typed: blank for the home page, a path, or a
 * full address on their own site (the most likely thing to be pasted).
 */
export function destinationFromInput(raw: string, origin: string): DestinationResult {
  const value = raw.trim();
  if (value === "") return { ok: true, path: "/" };
  if (CONTROL.test(value) || value.includes("\\")) return NOT_YOURS;
  if (value.length > MAX_PATH_LENGTH) {
    return { ok: false, message: "That address is too long. Use the page's own path, such as /services." };
  }

  let path: string;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const looksLikeOwnHost = !hasScheme && sameSite(value.split(/[/?#]/)[0] ?? "", origin);
  if (hasScheme || looksLikeOwnHost) {
    let url: URL;
    try {
      url = new URL(hasScheme ? value : `https://${value}`);
    } catch {
      return NOT_YOURS;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !sameSite(url.hostname, origin)) {
      return NOT_YOURS;
    }
    path = `${url.pathname}${url.search}${url.hash}`;
  } else {
    if (value.startsWith("//")) return NOT_YOURS;
    path = value.startsWith("/") ? value : `/${value}`;
  }

  // Resolved against the origin and read back, which both normalises the
  // encoding and proves the path cannot name another host.
  const resolved = new URL(path, `${origin}/`);
  if (resolved.origin !== origin) return NOT_YOURS;
  return { ok: true, path: `${resolved.pathname}${resolved.search}${resolved.hash}` };
}

/**
 * Where a scan is sent: the client's page, tagged for their analytics.
 *
 * `utm_medium` is `qr` for every placement, so "everything from print" is
 * one filter; the placement is the source and the campaign is the campaign.
 */
export function destinationUrl(input: {
  origin: string;
  path: string;
  placement: CampaignPlacement;
  utmCampaign: string;
}): string {
  let url = new URL(input.path, `${input.origin}/`);
  // Stored paths are validated on the way in; this is the second barrier.
  if (url.origin !== input.origin) url = new URL("/", `${input.origin}/`);
  url.searchParams.set("utm_source", placementSource(input.placement));
  url.searchParams.set("utm_medium", "qr");
  url.searchParams.set("utm_campaign", input.utmCampaign);
  return url.toString();
}

/** A readable `utm_campaign` from the campaign's name. */
export function utmCampaignSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "campaign";
}

// ---------------------------------------------------------------------------
// The short link
// ---------------------------------------------------------------------------

const DEFAULT_LINK_BASE = "https://portal.mortensenweb.com";

/**
 * Where short links live.
 *
 * `CAMPAIGN_LINK_BASE` exists so a shorter host can be adopted without a
 * code change. Whatever host a code was printed with must keep answering
 * `/q/<code>` for as long as that print is in the world — changing this only
 * affects codes downloaded afterwards.
 */
function linkBase(): string {
  return (process.env.CAMPAIGN_LINK_BASE || process.env.AUTH_URL || DEFAULT_LINK_BASE).replace(/\/+$/, "");
}

export function shortLink(code: string): string {
  return `${linkBase()}/q/${code}`;
}

/** The short link as printed under the code: no scheme, nothing to mistype. */
export function printedLink(code: string): string {
  return shortLink(code).replace(/^https?:\/\//, "");
}
