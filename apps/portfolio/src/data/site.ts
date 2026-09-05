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
  tagline: "Websites for small businesses, built and looked after.",
  description:
    "Mortensen Web Co. builds and maintains websites for small businesses. A site designed around what you actually sell, then kept current — you request a change, we make it, you approve it, it goes live.",
  // Umami Cloud website id for this site. Public by nature (it is in the
  // page); the API key that reads the figures never leaves the portal.
  umamiWebsiteId: "e71828c7-4b0e-4e06-8049-bd108a3b6fab",
} as const;

export const NAV = [
  { href: "/work/", label: "Work" },
  { href: "/services/", label: "Services" },
  { href: "/pricing/", label: "Pricing" },
  { href: "/contact/", label: "Contact" },
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
