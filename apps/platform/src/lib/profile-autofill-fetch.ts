import { extractPage } from "@/lib/crawl/extract";
import { fetchPublicPage } from "@/lib/crawl/fetch";
import { suggestProfile, type FetchedPage } from "@/lib/profile-autofill";
import type { BusinessDetails } from "@/lib/business-profile";

/**
 * Fetch a client's site and read General information off it.
 *
 * The home page, then at most two pages it links to that look like contact or
 * about pages, which is where hours and addresses usually live. Every fetch
 * goes through `fetchPublicPage`, which refuses private addresses, caps size
 * and time, and follows redirects itself.
 */

const EXTRA_PAGES = 2;
const LIKELY = /\/(contact|about|location|hours|visit|find-us)/i;

export type AutofillOutcome =
  | { ok: true; found: BusinessDetails; pagesRead: number }
  | { ok: false; message: string };

export function normaliseSiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function readProfileFromSite(siteUrl: string): Promise<AutofillOutcome> {
  const home = await fetchPublicPage(siteUrl);
  if (!home.ok) {
    return { ok: false, message: `Couldn't read ${siteUrl}: ${home.detail}` };
  }

  const pages: FetchedPage[] = [{ url: home.finalUrl, html: home.html }];
  const origin = new URL(home.finalUrl).origin;
  const extras = extractPage(home.html, home.finalUrl)
    .links.filter((link) => link.startsWith(origin) && LIKELY.test(new URL(link).pathname))
    .slice(0, EXTRA_PAGES);

  const fetched = await Promise.all(extras.map((link) => fetchPublicPage(link)));
  for (const page of fetched) {
    if (page.ok) pages.push({ url: page.finalUrl, html: page.html });
  }

  return { ok: true, found: suggestProfile(pages), pagesRead: pages.length };
}
