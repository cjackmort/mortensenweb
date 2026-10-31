/**
 * Writing the portal's identifiers into a site's `site.json`.
 *
 * Two values the site cannot work out for itself: the Umami website its pages
 * report to, and the site's id in the portal, which the booking and shop pages
 * send with every request. A concept generated from one of our other sites
 * carries *that* site's values, so they are replaced, not just filled — a copy
 * left in place would count this site's visitors in someone else's dashboard.
 *
 * Only blocks the file already has are touched, apart from `analytics`, which
 * every version of the template reads. Adding a `booking` block to a site
 * with no booking page would do nothing but confuse whoever reads it next.
 */

export interface PortalIdentifiers {
  umamiWebsiteId: string;
  /** The configured Umami's script URL; null or Cloud's leaves the template default. */
  umamiScriptUrl: string | null;
  sitePublicId: string;
}

export interface ConnectedSiteJson {
  text: string;
  /** Dotted paths that changed. Empty when the file already said all of it. */
  changed: string[];
  /**
   * True when the site loads Umami from Cloud but the portal's Umami is
   * self-hosted, and the file has no `analytics.umamiScriptUrl` to say so.
   */
  scriptOriginMismatch: boolean;
}

const UMAMI_CLOUD_SCRIPT = "https://cloud.umami.is/script.js";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function indentOf(source: string): string {
  return /\n([ \t]+)"/.exec(source)?.[1] ?? "  ";
}

export function connectSiteJson(
  source: string,
  raw: Json,
  ids: PortalIdentifiers,
): ConnectedSiteJson {
  const doc: Json = structuredClone(raw);
  const changed: string[] = [];

  const set = (target: Json, key: string, value: string, path: string) => {
    if (target[key] === value) return;
    target[key] = value;
    changed.push(path);
  };

  const analytics: Json = isObject(doc.analytics) ? doc.analytics : {};
  doc.analytics = analytics;
  set(analytics, "umamiWebsiteId", ids.umamiWebsiteId, "analytics.umamiWebsiteId");

  const selfHosted = Boolean(ids.umamiScriptUrl) && ids.umamiScriptUrl !== UMAMI_CLOUD_SCRIPT;
  const hasScriptKey = "umamiScriptUrl" in analytics;
  if (selfHosted && hasScriptKey) {
    set(analytics, "umamiScriptUrl", ids.umamiScriptUrl!, "analytics.umamiScriptUrl");
  }

  if (isObject(doc.booking) && isObject(doc.booking.portal)) {
    set(doc.booking.portal, "siteId", ids.sitePublicId, "booking.portal.siteId");
  }
  if (isObject(doc.shop)) {
    set(doc.shop, "siteId", ids.sitePublicId, "shop.siteId");
  }

  const trailingNewline = source.endsWith("\n") ? "\n" : "";
  return {
    text: changed.length > 0 ? JSON.stringify(doc, null, indentOf(source)) + trailingNewline : source,
    changed,
    scriptOriginMismatch: selfHosted && !hasScriptKey,
  };
}
