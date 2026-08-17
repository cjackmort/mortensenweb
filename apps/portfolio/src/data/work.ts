/**
 * The public portfolio.
 *
 * Adding a site is meant to be one entry in this array plus an image in
 * `public/work/` — no component changes. Keep the newest first; the homepage
 * shows `FEATURED_COUNT` of them and `/work` shows all.
 *
 * Two rules apply to anything added here, and both exist because this page
 * makes a claim about a real business that the business itself did not write:
 *
 * 1. **Live client work needs the client's agreement to be shown.** The portal
 *    models this as a stored `publicDisplayApproved` decision rather than a
 *    config toggle, and this file is the same decision made by hand. If you
 *    cannot point at when they agreed, it does not go here.
 * 2. **Anything not live says so, in `status`.** A concept, a redesign
 *    proposal, or an internal demo is interesting work and worth showing —
 *    but presenting one as a shipped client engagement is a claim that is not
 *    true, and it is the kind that gets noticed by the business in question.
 */

export type WorkStatus = "live" | "concept" | "internal";

export type Work = {
  /** Stable slug. Used as the React key and the image basename. */
  slug: string;
  name: string;
  /** What the business does — one short line, shown above the title. */
  sector: string;
  /** Present tense, concrete, no adjectives that cannot be checked. */
  description: string;
  /** Bare hostname, shown to the visitor. */
  domain: string;
  /** Full URL including protocol. */
  href: string;
  status: WorkStatus;
  /** Short capability labels. Three or four reads best; more wraps badly. */
  tags: string[];
  /** Path under `public/`. 16:10 or wider, already web-sized. */
  image: string;
  /** Describes the image for anyone who cannot see it — not the project. */
  imageAlt: string;
  year: number;
};

/** How many entries the homepage shows before "View all work". */
export const FEATURED_COUNT = 3;

export const WORK: Work[] = [
  {
    slug: "scott-mortensen-fine-arts",
    name: "Scott Mortensen Fine Arts",
    sector: "Bronze sculpture studio",
    description:
      "A five-page gallery site for a western wildlife sculptor. Full-bleed photography of the work, a gallery that keeps each piece whole rather than cropping it to a grid, and a commission enquiry form. Built to make the sculpture the only thing competing for attention.",
    domain: "scottmortensenfinearts.com",
    href: "https://scottmortensenfinearts.com",
    status: "live",
    tags: ["Gallery site", "Photography-led", "Commission enquiries"],
    image: "/work/scott-mortensen-fine-arts.jpg",
    imageAlt:
      "A bronze mountain lion sculpture by Scott Mortensen, shown mid-stride.",
    year: 2026,
  },
];

export const STATUS_LABEL: Record<WorkStatus, string> = {
  live: "Live",
  concept: "Concept",
  internal: "In-house",
};
