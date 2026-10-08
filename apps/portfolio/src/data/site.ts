/**
 * Site-wide constants.
 *
 * The portal URL is the one link on this site that leaves it. Getting it
 * wrong sends an existing client somewhere that does not have their session.
 */
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
    "Web design in Riverton, Utah for small businesses: websites from $100, unlimited changes, and a leads inbox for every enquiry. Plans from $25 a month.",
  description:
    "Mortensen Web Co. is a web design company in Riverton, Utah that builds, hosts and looks after websites for small businesses — with unlimited changes, a leads inbox for every enquiry, and Growth tools that bring in more customers. Sites from $100; plans from $25 a month.",
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
 * a client on their progress track.
 */
export const LOOP = [
  {
    n: "01",
    title: "You ask",
    body: "In your portal, in your own words. Attach a photo if it helps — a picture of the thing you mean is usually faster than describing it.",
  },
  {
    n: "02",
    title: "We build it",
    body: "The change is made on a copy of your site, checked — every link, every image — and put up at a private address. Usually within the hour.",
  },
  {
    n: "03",
    title: "You approve",
    body: "You get an email with the preview and a picture of the change. Looks right? One tap. Not quite? Say what's off — it doesn't cost another change.",
  },
  {
    n: "04",
    title: "It's live",
    body: "We publish, check your live site actually serves it, and tell you. Then it shows up in your visitor numbers like everything else.",
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
