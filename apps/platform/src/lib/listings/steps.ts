/**
 * The "Get listed" checklist: the places a business has to be listed once
 * its website is live, and why each one matters, in the client's words.
 *
 * Fixed rather than configurable. Every client gets the same eight, in the
 * same order, so the operator can work the list top to bottom and a client
 * reading it a year later still recognises it. Adding a step means adding it
 * here and to the migration's CHECK constraint, in that order.
 *
 * Nothing here is a verifiable fact about any one business (rule 8 in the
 * agency's CLAUDE.md): the `why` lines describe what each directory is for,
 * never what the client has or has not done.
 */

export const LISTING_STEP_KEYS = [
  "google_business_profile",
  "search_console",
  "bing_webmaster",
  "apple_business_connect",
  "yelp",
  "bbb",
  "nextdoor",
  "facebook",
] as const;

export type ListingStepKey = (typeof LISTING_STEP_KEYS)[number];

export interface ListingStepDefinition {
  key: ListingStepKey;
  title: string;
  /** Plain English: what this listing does for the business. One or two sentences. */
  why: string;
  /** Where the work is done, for the person doing it. */
  url: string;
}

export const LISTING_STEPS: readonly ListingStepDefinition[] = [
  {
    key: "google_business_profile",
    title: "Google Business Profile claimed and verified",
    why: "This is the listing on Google Maps and the panel beside search results, with the hours, phone number and reviews. Most local customers find a business here before they ever see its website.",
    url: "https://business.google.com/",
  },
  {
    key: "search_console",
    title: "Google Search Console verified and sitemap submitted",
    why: "Tells Google the website exists and which pages to index, and shows which searches bring people in. Without it a new site can take weeks to appear.",
    url: "https://search.google.com/search-console",
  },
  {
    key: "bing_webmaster",
    title: "Bing Webmaster Tools imported from Search Console",
    why: "Bing is the search engine inside Windows, Edge and several AI assistants. Importing takes a minute and copies what Search Console already knows.",
    url: "https://www.bing.com/webmasters",
  },
  {
    key: "apple_business_connect",
    title: "Apple Business Connect",
    why: "Apple Maps is the default on every iPhone. Claiming the place card puts the right hours, phone number and website in front of anyone who looks the business up there.",
    url: "https://businessconnect.apple.com/",
  },
  {
    key: "yelp",
    title: "Yelp listing claimed",
    why: "Yelp pages often sit near the top of a search for a business's name plus \"reviews\", and other directories copy their details from it.",
    url: "https://biz.yelp.com/",
  },
  {
    key: "bbb",
    title: "Better Business Bureau profile",
    why: "A BBB profile shows up for name searches and is a sign of trust for customers who check before they call.",
    url: "https://www.bbb.org/get-accredited",
  },
  {
    key: "nextdoor",
    title: "Nextdoor business page",
    why: "Neighbours ask each other for recommendations on Nextdoor. A page there lets the business be tagged in the answer.",
    url: "https://business.nextdoor.com/",
  },
  {
    key: "facebook",
    title: "Facebook page linked to the website",
    why: "Many people check Facebook for hours and photos. Linking the page to the website, and the website to the page, keeps the two telling the same story.",
    url: "https://www.facebook.com/business/pages",
  },
];

/** What every listing has to agree on. Said once, above the list. */
export const LISTING_CONSISTENCY_NOTE =
  "Use exactly the same business name, address and phone number on every listing, spelled the same way as on the website. Directories and search engines match them against each other, and a mismatch reads as two different businesses.";

export function isListingStepKey(value: string): value is ListingStepKey {
  return (LISTING_STEP_KEYS as readonly string[]).includes(value);
}

/** A note or link is a reminder, not a document. */
export const MAX_LISTING_NOTE_CHARS = 500;

export interface ListingProgress {
  done: number;
  total: number;
  /** "5 of 8 done" */
  label: string;
  /** True while fewer than half the steps are done: the dashboard reminder shows. */
  needsReminder: boolean;
}

export function listingProgress(states: ReadonlyArray<{ done: boolean }>): ListingProgress {
  const total = LISTING_STEP_KEYS.length;
  const done = states.filter((s) => s.done).length;
  return {
    done,
    total,
    label: `${done} of ${total} done`,
    needsReminder: done * 2 < total,
  };
}
