import type { ScanDevice } from "@/db/schema/campaigns";

/**
 * What a scan is allowed to know about the person scanning.
 *
 * A QR code on a door hanger is scanned by someone standing on their own
 * porch. Recording their address — even their IP address — to tell a
 * plumber that door hangers work would be out of all proportion, so this
 * module reduces a request to three coarse facts and a hash:
 *
 *  - a device class (phone, tablet, computer),
 *  - the town, state and country Netlify's edge already worked out,
 *  - an HMAC of address and browser under a key that changes every day.
 *
 * The IP address itself is read, used as an input, and dropped. Nothing
 * here returns it.
 */

export type DeviceClass = ScanDevice | "bot";

/**
 * Link previews, crawlers and scripts.
 *
 * Sending a short link in a text message makes the messaging app fetch it
 * for a preview card; without this, every shared link would be a "scan"
 * from a phone that never scanned anything.
 */
const BOT =
  /bot\b|bot[/-]|crawl|spider|slurp|facebookexternalhit|facebot|embedly|preview|whatsapp|telegram|discord|slack|linkedin|skype|curl\/|wget\/|python-requests|go-http-client|okhttp|headless|lighthouse|pingdom|uptime/i;
const TABLET = /ipad|tablet|kindle|silk\/|playbook/i;
const MOBILE = /mobi|iphone|ipod|android|windows phone|blackberry/i;
const DESKTOP = /windows nt|macintosh|mac os x|x11|linux|cros/i;

export function deviceClass(headers: Headers): DeviceClass {
  const ua = headers.get("user-agent")?.trim() ?? "";
  if (ua && BOT.test(ua)) return "bot";
  // The browser's own answer, when it gives one, beats parsing a string
  // that browsers have spent twenty years making ambiguous on purpose.
  if (headers.get("sec-ch-ua-mobile") === "?1") return "mobile";
  if (!ua) return "unknown";
  // Android tablets send "Android" without "Mobile"; phones send both.
  if (TABLET.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return "tablet";
  if (MOBILE.test(ua)) return "mobile";
  if (DESKTOP.test(ua)) return "desktop";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

export interface CoarsePlace {
  city: string | null;
  /** Subdivision code without the country: `UT`. */
  region: string | null;
  /** ISO 3166-1 alpha-2: `US`. */
  country: string | null;
}

const NOWHERE: CoarsePlace = { city: null, region: null, country: null };
const MAX_CITY_LENGTH = 80;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

interface NetlifyGeo {
  city?: unknown;
  country?: { code?: unknown };
  subdivision?: { code?: unknown };
}

/**
 * `x-nf-geo` is base64-encoded JSON set by Netlify on every request to a
 * function. Only the town, the subdivision code and the country code are
 * read; latitude, longitude and postcode are in the header and are
 * deliberately left there.
 *
 * Anything malformed records nothing. A blank town is a gap on a chart; a
 * wrong one sends a client to canvass the wrong neighbourhood.
 */
export function coarsePlace(headers: Headers): CoarsePlace {
  const geo = parseGeo(headers.get("x-nf-geo"));
  if (geo) {
    return {
      city: cleanCity(geo.city),
      region: cleanRegion(geo.subdivision?.code),
      country: cleanCountry(geo.country?.code),
    };
  }
  const country = cleanCountry(headers.get("x-country"));
  return country ? { ...NOWHERE, country } : NOWHERE;
}

function parseGeo(raw: string | null): NetlifyGeo | null {
  if (!raw) return null;
  const value = raw.trim();
  try {
    const json = value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as NetlifyGeo) : null;
  } catch {
    return null;
  }
}

function cleanCity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const city = value.replace(CONTROL, "").trim();
  return city.length > 0 && city.length <= MAX_CITY_LENGTH ? city : null;
}

function cleanRegion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Some sources send `US-UT`; the country is recorded separately.
  const code = value.trim().toUpperCase().split("-").pop() ?? "";
  return /^[A-Z0-9]{1,3}$/.test(code) ? code : null;
}

function cleanCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// The visitor hash
// ---------------------------------------------------------------------------

/**
 * One visitor, today — and only today.
 *
 * The UTC date is part of what is hashed, so the same phone produces an
 * unrelated value tomorrow: enough to collapse a double scan and cap one
 * person's contribution to a count, not enough to follow anyone. The key is
 * the portal's own secret, so the table alone cannot be brute-forced back to
 * an address.
 *
 * Null without an address or a key, never a constant: a constant would put
 * every scan in one bucket and the first visitor's dedupe would swallow
 * everyone else's.
 */
export async function visitorHash(
  secret: string | undefined,
  ip: string | undefined,
  userAgent: string | null,
  now: Date,
): Promise<string | null> {
  if (!secret || !ip) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const day = now.toISOString().slice(0, 10);
  const message = `campaign-scan|${day}|${ip}|${userAgent ?? ""}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Record one request; false when this key is over its limit. */
  hit(key: string, now?: number): boolean;
  size(): number;
}

/**
 * A fixed-window limit held in memory.
 *
 * Per function instance, so it is a flood guard rather than an exact
 * count: it stops one address hammering a link without a database round
 * trip per request. What is *counted* is limited separately, in the
 * database, where every instance sees the same rows.
 */
export function createRateLimiter(options: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();

  function evict(now: number) {
    for (const [key, entry] of windows) {
      if (now - entry.start >= options.windowMs) windows.delete(key);
    }
    // Still full of live windows: drop the oldest. Map keeps insertion order.
    for (const key of windows.keys()) {
      if (windows.size <= maxKeys) break;
      windows.delete(key);
    }
  }

  return {
    hit(key, now = Date.now()) {
      const entry = windows.get(key);
      if (!entry || now - entry.start >= options.windowMs) {
        windows.delete(key);
        windows.set(key, { start: now, count: 1 });
        if (windows.size > maxKeys) evict(now);
        return true;
      }
      if (entry.count >= options.limit) return false;
      entry.count += 1;
      return true;
    },
    size() {
      return windows.size;
    },
  };
}
