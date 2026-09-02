/**
 * Site-wide constants.
 *
 * The portal URL is here rather than inline because it appears in the header,
 * the footer, and the client FAQ — and because it is the one link on this site
 * that leaves it. Getting it wrong sends an existing client somewhere that
 * does not have their session.
 */
export const SITE = {
  name: "Mortensen Web Co.",
  shortName: "MortensenWeb",
  url: "https://mortensenweb.com",
  portalUrl: "https://portal.mortensenweb.com",
  email: "mortensenwebco@gmail.com",
  tagline: "Websites for small businesses, built and looked after.",
} as const;

export const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/work/", label: "Work" },
  { href: "/services/", label: "Services" },
  { href: "/pricing/", label: "Pricing" },
  { href: "/contact/", label: "Contact" },
] as const;
