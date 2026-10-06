import { extractFacts, extractPage } from "@/lib/crawl/extract";
import type { BusinessDetails } from "@/lib/business-profile";

/**
 * General information, read off the client's existing website.
 *
 * Suggestions, never saved by this: the operator sees them in the form, marked,
 * and saves. Only what a site states plainly about how to reach the business
 * is read — name, description, contact details, hours, a booking link, the
 * profiles it links to. Licences, awards, founding years and the like are
 * never filled, because a claim read off a page is exactly what a new site
 * must not republish until someone has confirmed it.
 *
 * Pages are given in priority order, home page first: an earlier page's
 * answer wins, later pages only fill gaps.
 */

export interface FetchedPage {
  url: string;
  html: string;
}

type SocialKey = "facebook" | "instagram" | "tiktok" | "youtube" | "linkedin" | "yelp" | "googleBusiness";

/** Where a profile lives, and the paths on those hosts that are not one. */
const SOCIAL: Array<{ key: SocialKey; host: RegExp; path?: RegExp; notPath?: RegExp }> = [
  { key: "facebook", host: /(^|\.)facebook\.com$/, notPath: /^\/(sharer|share|dialog|plugins|tr)\b/ },
  { key: "instagram", host: /(^|\.)instagram\.com$/, notPath: /^\/(p|reel|explore)\// },
  { key: "tiktok", host: /(^|\.)tiktok\.com$/, path: /^\/@/ },
  { key: "youtube", host: /(^|\.)youtube\.com$/, path: /^\/(@|channel\/|c\/|user\/)/ },
  { key: "linkedin", host: /(^|\.)linkedin\.com$/, path: /^\/(company|in)\// },
  { key: "yelp", host: /(^|\.)yelp\.com$/, path: /^\/biz\// },
  { key: "googleBusiness", host: /^(g\.page|business\.google\.com|maps\.app\.goo\.gl)$/ },
  { key: "googleBusiness", host: /(^|\.)google\.com$/, path: /^\/maps\b/ },
];

/** Scheduling tools a "Book now" button usually points at. */
const BOOKING_HOSTS =
  /(^|\.)(calendly\.com|acuityscheduling\.com|as\.me|squareup\.com|square\.site|vagaro\.com|booksy\.com|setmore\.com|housecallpro\.com|getjobber\.com|schedulicity\.com|mindbodyonline\.com|fresha\.com|simplybook\.me|tidycal\.com|zcal\.co)$/;
const BOOKING_WORDS = /\b(book|booking|schedule|appointment|reserve|get a quote|request a quote|free estimate)\b/i;

export function suggestProfile(pages: FetchedPage[]): BusinessDetails {
  const found: BusinessDetails = {};
  const offer = (key: string, value: string | null | undefined) => {
    const cleaned = value?.trim();
    if (cleaned && !found[key]) found[key] = cleaned;
  };

  if (pages[0]) offer("website", pages[0].url);

  for (const { url, html } of pages) {
    const page = extractPage(html, url);
    const facts = extractFacts(page, html);
    const best = (key: string) =>
      facts.filter((f) => f.key === key && !f.sensitive).sort((a, b) => b.confidence - a.confidence)[0]?.value;
    const all = (key: string) => facts.filter((f) => f.key === key).map((f) => f.value);

    offer("businessName", best("business_name") ?? titleName(page.title));
    offer("tagline", page.metaDescription?.slice(0, 200));
    offer("phone", best("phone"));
    offer("email", best("email"));
    offer("address", address(best));
    offer("hours", all("opening_hours").join("\n"));

    const anchors = anchorsIn(html, url);
    offer("bookingUrl", bookingLink(anchors));
    for (const { href } of anchors) {
      const key = socialKey(href);
      if (key) offer(key, href);
    }
  }

  return found;
}

/** "Plain Bakery | Fresh bread daily" → "Plain Bakery". */
function titleName(title: string | null): string | null {
  const first = title?.split(/\s[|–—-]\s/)[0]?.trim();
  return first || null;
}

function address(best: (key: string) => string | undefined): string | null {
  const street = best("street_address");
  const town = best("locality");
  const regionLine = [best("region"), best("postal_code")].filter(Boolean).join(" ");
  const parts = [street, town, regionLine].filter(Boolean);
  return street || town ? parts.join(", ") : null;
}

interface Anchor {
  href: string;
  text: string;
}

function anchorsIn(html: string, base: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const raw = /href\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? "")?.[1];
    if (!raw) continue;
    try {
      const url = new URL(raw.replace(/&amp;/g, "&"), base);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      anchors.push({ href: url.toString(), text: (match[2] ?? "").replace(/<[^>]+>/g, " ").trim() });
    } catch {
      // Not a URL; nothing to suggest from it.
    }
  }
  return anchors;
}

function socialKey(href: string): SocialKey | null {
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  const match = SOCIAL.find(
    (s) =>
      s.host.test(host) &&
      (!s.path || s.path.test(url.pathname)) &&
      (!s.notPath || !s.notPath.test(url.pathname)) &&
      url.pathname.length > 1,
  );
  return match?.key ?? null;
}

function bookingLink(anchors: Anchor[]): string | null {
  const known = anchors.find((a) => BOOKING_HOSTS.test(new URL(a.href).hostname.toLowerCase()));
  if (known) return known.href;
  return anchors.find((a) => BOOKING_WORDS.test(a.text))?.href ?? null;
}
