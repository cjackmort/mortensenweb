import { parseProfileForm, type BusinessDetails } from "@/lib/business-profile";
import { looksLikePlaceholder, siteDomain, type SiteJson } from "./read";

/**
 * General information, read from a site's `site.json`.
 *
 * The mapping is the one in the agency's `new-client` reference
 * (`reference/connections.md` → "General information from site.json"). Only
 * what the file states is read; `about`, `founded`, `payment`, `credentials`
 * and `awards` are not in it and are left for the client.
 *
 * Every value is put through the same validation as the operator's form, so a
 * malformed phone number in the file is dropped here rather than stored and
 * later published.
 */

export interface ProfileFromSite {
  details: BusinessDetails;
  /** Keys the file had a value for that was a placeholder or failed validation. */
  rejected: string[];
}

function joinLines(values: (string | undefined)[], separator: string): string | undefined {
  const kept = values.map((v) => v?.trim()).filter((v): v is string => Boolean(v));
  return kept.length > 0 ? kept.join(separator) : undefined;
}

function hoursText(site: SiteJson): string | undefined {
  return joinLines(
    (site.contact?.hours ?? []).map((h) => {
      const days = h.days?.trim();
      const open = h.open?.trim();
      const close = h.close?.trim();
      if (!days || !open) return undefined;
      return close ? `${days} ${open}–${close}` : `${days} ${open}`;
    }),
    "\n",
  );
}

function addressText(site: SiteJson): string | undefined {
  const a = site.contact?.address;
  if (!a?.street?.trim() && !a?.city?.trim()) return undefined;
  return joinLines([a.street, a.city, joinLines([a.state, a.zip], " ")], ", ");
}

function brandText(site: SiteJson): string | undefined {
  return joinLines(
    Object.entries(site.brand ?? {}).map(([key, value]) =>
      typeof value === "string" && value.trim() ? `${key}: ${value.trim()}` : undefined,
    ),
    "\n",
  );
}

/** An absolute http(s) link, resolving a path against the site's own address. */
function absoluteLink(href: string | undefined, siteUrl: string | null): string | undefined {
  const value = href?.trim();
  if (!value || /^(tel|mailto|sms):/i.test(value) || value.startsWith("#")) return undefined;
  try {
    const url = siteUrl ? new URL(value, siteUrl) : new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function profileFromSiteJson(site: SiteJson): ProfileFromSite {
  const domain = siteDomain(site);
  const siteUrl = domain ? `https://${domain}` : null;

  const candidates: Record<string, string | undefined> = {
    businessName: site.meta?.businessName,
    tagline: site.meta?.tagline?.trim() || site.seo?.description,
    phone: site.contact?.phone,
    email: site.contact?.email,
    address: addressText(site),
    hours: hoursText(site),
    services: joinLines((site.services ?? []).map((s) => s.title), "\n"),
    serviceArea: joinLines(site.seo?.serviceArea ?? [], ", "),
    bookingUrl:
      site.booking?.enabled === true && siteUrl
        ? `${siteUrl}/book`
        : absoluteLink(site.hero?.secondaryCta?.href, siteUrl),
    website: siteUrl ?? undefined,
    facebook: site.contact?.social?.facebook,
    instagram: site.contact?.social?.instagram,
    googleBusiness: site.contact?.social?.google,
    brand: brandText(site),
  };

  const rejected: string[] = [];
  const form = new FormData();
  for (const [key, value] of Object.entries(candidates)) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    if (looksLikePlaceholder(trimmed)) {
      rejected.push(key);
      continue;
    }
    form.set(key, trimmed);
  }

  const parsed = parseProfileForm(form);
  const details: BusinessDetails = {};
  for (const [key, value] of Object.entries(parsed.details)) {
    if (!parsed.ok && parsed.errors[key]) rejected.push(key);
    else details[key] = value;
  }

  return { details, rejected };
}

/**
 * Fill only what is empty. A value already in General information was typed
 * by the client or the operator, and the file never wins over a person.
 */
export function fillProfileGaps(
  existing: BusinessDetails,
  fromSite: BusinessDetails,
): { details: BusinessDetails; filled: string[]; kept: string[] } {
  const details: BusinessDetails = { ...existing };
  const filled: string[] = [];
  const kept: string[] = [];

  for (const [key, value] of Object.entries(fromSite)) {
    if (existing[key]?.trim()) {
      if (existing[key] !== value) kept.push(key);
      continue;
    }
    details[key] = value;
    filled.push(key);
  }

  return { details, filled, kept };
}
