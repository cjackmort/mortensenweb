/**
 * What a .com domain costs to keep, for the price guide and llms.txt.
 *
 * Renewal prices, not first-year prices: the first year is often discounted,
 * and every year after it is what a business actually pays. Each one was read
 * off the registrar's own site on `checkedOn`. Re-check them and update the
 * date together — a stale price with a fresh date is worse than either.
 *
 * The three registrars are ones the portal's domain step also lists, so a
 * client reading the guide meets the same names when they connect a domain.
 */
export interface DomainPrice {
  registrar: string;
  /** Yearly .com renewal, in cents, as the registrar lists it. */
  renewalCents: number;
  /** Anything the registrar adds on top of the listed price. */
  note?: string;
  /** The page the price was read from. */
  source: string;
}

export const DOMAIN_PRICES_CHECKED_ON = "2026-10-21";

export const COM_RENEWALS: DomainPrice[] = [
  {
    registrar: "Cloudflare",
    renewalCents: 1046,
    note: "Sold at cost",
    source: "https://www.cloudflare.com/domains/search/",
  },
  {
    registrar: "Namecheap",
    renewalCents: 1848,
    note: "Plus a $0.20 ICANN fee",
    source: "https://www.namecheap.com/domains/",
  },
  {
    registrar: "GoDaddy",
    renewalCents: 2299,
    source: "https://www.godaddy.com/tlds/com-domain",
  },
];

/** "$10.46", with cents, for prices that are not round. */
export function exactDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const renewals = COM_RENEWALS.map((p) => p.renewalCents);

/** "$10–$23", rounded outward, for a sentence that quotes the spread. */
export const COM_RENEWAL_RANGE = `$${Math.floor(Math.min(...renewals) / 100)}–$${Math.ceil(Math.max(...renewals) / 100)}`;

/** "October 21, 2026". */
export const DOMAIN_PRICES_CHECKED = new Date(`${DOMAIN_PRICES_CHECKED_ON}T00:00:00Z`).toLocaleDateString("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
