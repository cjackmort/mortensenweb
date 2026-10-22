/**
 * Where we tell a new client to buy their domain, and how they give us
 * access to it.
 *
 * The client buys the domain themselves, in their own name, so it stays
 * theirs if they ever leave. We need to manage its DNS. A registrar is listed
 * only if it lets the owner give another account access to that domain (or
 * its DNS) without handing over their password, and nothing it does stops
 * the domain pointing at Netlify.
 *
 * Every fact here was checked on the registrar's own pages on the date in
 * `checkedOn`, with the page in `sources`. Prices and menus change: re-check
 * a registrar before relying on it, update its entry, and move the date.
 *
 * Checked and left out (2026-10-22):
 * - **Porkbun** ($11.08/yr): its password-free option, Authorized Users,
 *   opens the whole account, not one domain or its DNS, and needs app-based
 *   2FA on both accounts. https://kb.porkbun.com/article/242-subaccounts-vs-authorized-users
 * - Registering through Netlify or through our own account: the client must
 *   own the domain.
 */

export type RegistrarKey = "cloudflare" | "namecheap" | "squarespace" | "godaddy";

export interface Registrar {
  key: RegistrarKey;
  name: string;
  /** Where to search for and buy a domain. */
  buyUrl: string;
  /** A .com, per year, at renewal — what they pay every year after the first. */
  renewal: string;
  /** Anything about price the client should know before buying. */
  priceNote: string | null;
  /** What the access they give us covers. */
  access: string;
  /** Steps to give us access. `{email}` is replaced with our access address. */
  steps: string[];
  /** Anything that trips the client up. */
  watchOut: string[];
  /** For us, when adding the Netlify records there. */
  operatorNote: string | null;
  sources: Array<{ label: string; url: string }>;
  /** `YYYY-MM-DD`: when the facts above were last checked. */
  checkedOn: string;
}

export const REGISTRARS: Registrar[] = [
  {
    key: "cloudflare",
    name: "Cloudflare Registrar",
    buyUrl: "https://www.cloudflare.com/products/registrar/",
    renewal: "$10.46 a year",
    priceNote: "Sold at cost: the same price to register and to renew.",
    access: "Edit DNS for this one domain (the Domain DNS role)",
    steps: [
      "Sign in to Cloudflare and go to Members in your account.",
      "Select Invite members and enter {email}.",
      "Under the permission policy, choose specific domains, pick your domain, and select the Domain DNS role.",
      "Select Create policy, then Invite members.",
    ],
    watchOut: [
      "Domains at Cloudflare always use Cloudflare's DNS. That's fine: we add our records there.",
      "Inviting members needs the Super Administrator role, which the account's owner has.",
    ],
    operatorNote:
      "Set both records to DNS only (grey cloud). Netlify recommends turning Cloudflare's proxy off for sites it hosts.",
    sources: [
      { label: "Prices", url: "https://pricing.registrar.cloudflare.com/" },
      { label: "Domain-scoped roles", url: "https://developers.cloudflare.com/fundamentals/manage-members/roles/" },
      { label: "Inviting members", url: "https://developers.cloudflare.com/fundamentals/manage-members/manage/" },
      { label: "Registrar FAQ (nameservers)", url: "https://developers.cloudflare.com/registrar/faq/" },
      {
        label: "Netlify on Cloudflare's proxy",
        url: "https://answers.netlify.com/t/support-guide-what-problems-could-occur-when-using-cloudflare-in-front-of-netlify/138",
      },
    ],
    checkedOn: "2026-10-22",
  },
  {
    key: "namecheap",
    name: "Namecheap",
    buyUrl: "https://www.namecheap.com/domains/registration/gtld/com/",
    renewal: "$18.48 a year",
    priceNote: "The first year is cheaper; renewal is $18.48, plus a $0.20 ICANN fee.",
    access: "The settings you pick for this one domain (choose DNS)",
    steps: [
      "Sign in to Namecheap, open Domain List and select Manage next to your domain.",
      "Open the Sharing & Transfer tab and find Share Access.",
      "Enter {email} as the new manager and select Add.",
      "Tick the DNS settings, enter your Namecheap password to confirm, and save. Your password is only used to confirm; it isn't shared.",
    ],
    watchOut: ["The invitation link we get lasts 7 days. Access can't be shared on an expired domain."],
    operatorNote: null,
    sources: [
      { label: "Prices", url: "https://www.namecheap.com/domains/registration/gtld/com/" },
      {
        label: "Share Access",
        url: "https://www.namecheap.com/support/knowledgebase/article.aspx/192/46/how-do-i-share-access-to-my-domain-with-other-users/",
      },
    ],
    checkedOn: "2026-10-22",
  },
  {
    key: "squarespace",
    name: "Squarespace Domains",
    buyUrl: "https://domains.squarespace.com/",
    renewal: "$20 a year",
    priceNote: null,
    access: "Domain manager for this one domain: settings and DNS, but not billing",
    steps: [
      "Open your domains dashboard at account.squarespace.com/domains and select your domain.",
      "Select Permissions, then Invite domain manager.",
      "Enter our name and {email}, and send the invitation.",
    ],
    watchOut: [
      "Buy the domain on its own, not with a Squarespace website plan. A domain attached to a website follows the website's permissions instead.",
    ],
    operatorNote:
      "DNS Settings has a Netlify preset that adds the A record and the CNAME. Delete Squarespace Defaults if it's there.",
    sources: [
      { label: "Prices (FAQ)", url: "https://support.squarespace.com/hc/en-us/articles/205812208-Squarespace-domains-FAQ" },
      {
        label: "Domain permissions",
        url: "https://support.squarespace.com/hc/en-us/articles/25974568684557-Managing-domain-permissions",
      },
      {
        label: "DNS for web hosting (Netlify preset)",
        url: "https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting",
      },
    ],
    checkedOn: "2026-10-22",
  },
  {
    key: "godaddy",
    name: "GoDaddy",
    buyUrl: "https://www.godaddy.com/tlds/com-domain",
    renewal: "$22.99 a year",
    priceNote: "The 1-cent first year needs a 3-year purchase; every year after is $22.99.",
    access: "Delegate access, Domains Only: manage DNS for the domains you allow",
    steps: [
      "Sign in to GoDaddy and open the Delegate Access page.",
      "Under People who can access my account, select Invite to Access.",
      "Enter our name and {email}, choose the Domains Only access level, and send the invitation.",
      "In your Domain Portfolio, keep Management Access on and Transfer Access off for us.",
    ],
    watchOut: ["Delegates can never see your password or payment methods. The invitation expires after 48–72 hours."],
    operatorNote: null,
    sources: [
      { label: "Prices", url: "https://www.godaddy.com/tlds/com-domain" },
      { label: "Inviting a delegate", url: "https://www.godaddy.com/help/invite-a-delegate-to-access-my-godaddy-account-12376" },
      { label: "Access levels", url: "https://www.godaddy.com/help/delegate-access-levels-of-permission-12374" },
      { label: "Domain permissions", url: "https://www.godaddy.com/help/grant-delegate-access-to-domains-32180" },
    ],
    checkedOn: "2026-10-22",
  },
];

/** A registrar the client named that is not on our list. */
export const OTHER_REGISTRAR = "other";

export function registrarName(key: string | null): string | null {
  if (!key) return null;
  if (key === OTHER_REGISTRAR) return "Somewhere else";
  return REGISTRARS.find((r) => r.key === key)?.name ?? null;
}

/** The registrar's steps with our access address filled in. */
export function stepsFor(registrar: Registrar, accessEmail: string): string[] {
  return registrar.steps.map((step) => step.replace("{email}", accessEmail));
}
