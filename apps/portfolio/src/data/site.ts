import { BUILD, CHEAPEST_PLAN, dollars } from "@mortensenweb/plans";

/**
 * Site-wide constants.
 *
 * The portal URL is the one link on this site that leaves it. Getting it
 * wrong sends an existing client somewhere that does not have their session.
 *
 * The two descriptions quote prices, so they read them from
 * `@mortensenweb/plans` like every page does: these were typed in once and
 * went on saying "from $100" after the build price changed.
 */
const build = dollars(BUILD.priceCents);
const plansFrom = dollars(CHEAPEST_PLAN.monthlyCents);

export const SITE = {
  name: "Mortensen Web Co.",
  shortName: "MortensenWeb",
  url: "https://mortensenweb.com",
  portalUrl: "https://portal.mortensenweb.com",
  email: "mortensenwebco@gmail.com",
  /** Matches the Google Business Profile exactly: name, place and phone have to agree everywhere. */
  phone: "(801) 865-9235",
  phoneHref: "tel:+18018659235",
  founder: "Jack Mortensen",
  founded: "2026",
  /**
   * Where the business is, for people and for search. The town, not the
   * street: it is run from home, and the street address stays off the site.
   */
  locality: "Riverton",
  region: "Utah",
  regionCode: "UT",
  areaServed: "the Salt Lake Valley — and small businesses anywhere, since everything happens online",
  tagline: "Websites for small businesses, built, looked after, and working to bring in customers.",
  /**
   * The canonical description, used as the default meta description and in
   * the structured data. Paste the same words into directory listings: an
   * entity described the same way everywhere is one AI answers can cite.
   */
  /** The meta description: the same facts, inside the ~160 characters a result shows. */
  metaDescription:
    `Web design in Riverton, Utah for small businesses: a website for ${build}, free performance tracking with a leads inbox, and plans from ${plansFrom} a month.`,
  description:
    `Mortensen Web Co. is a web design company in Riverton, Utah that builds, hosts and looks after websites for small businesses — with free performance tracking (visitor analytics and every enquiry in one place), unlimited changes, and Growth tools that bring in more customers. Websites ${build}; plans from ${plansFrom} a month.`,
  // Umami Cloud website id for this site. Public by nature (it is in the
  // page); the API key that reads the figures never leaves the portal.
  umamiWebsiteId: "e71828c7-4b0e-4e06-8049-bd108a3b6fab",
} as const;

/**
 * The main menu. `phone: false` keeps an item out of the phone menu strip,
 * which fits five links across a 360px screen and no more — About is in the
 * footer there instead.
 */
export const NAV = [
  { href: "/work/", label: "Work", phone: true },
  { href: "/services/", label: "Services", phone: true },
  { href: "/growth/", label: "Growth", phone: true },
  { href: "/pricing/", label: "Pricing", phone: true },
  { href: "/about/", label: "About", phone: false },
  { href: "/contact/", label: "Contact", phone: true },
] as const;

/**
 * The four steps a change goes through. A real sequence — which is why it is
 * numbered everywhere it appears — and the same four stages the portal shows
 * a client on their progress track. Each title says the whole step in plain
 * words (the operator's ask of 2026-10-21: "make it easy to read"), and the
 * line under it says what happens.
 */
export const LOOP = [
  {
    n: "01",
    title: "You request a change to your site",
    body: "Type what you want changed in your portal, in your own words. Add a photo if it helps.",
  },
  {
    n: "02",
    title: "We build it on a private preview and send it to you",
    body: "The change is made on a copy of your site, not the live one. You get the link, usually within the hour.",
  },
  {
    n: "03",
    title: "You approve the change",
    body: "Looks right? Approve it in one tap. Not quite? Tell us what's off and we fix it, free.",
  },
  {
    n: "04",
    title: "We push it live",
    body: "We publish it, check that your live site shows it, and let you know it's done.",
  },
] as const;

/** Plausible examples of what clients ask for — the marquee. */
export const REQUESTS = [
  "Change the phone number in the footer",
  "New photo on the services page",
  "Holiday hours until Jan 2",
  "Add the new price list",
  "Swap the hero photo for the one from Saturday",
  "Take down the summer special",
  "Put the Bison Coat Rack first in the gallery",
  "Add a line about the new location",
  "Update the menu PDF",
  "Move the phone number above the fold",
] as const;
