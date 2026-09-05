/**
 * The public portfolio, shown in full on `/work` — the homepage no longer
 * excerpts it.
 *
 * Adding a site is meant to be one entry in this array plus an image in
 * `public/work/` — no component changes. Keep the newest first.
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
 *    Demo/pitch builds go in as `"concept"`, never `"live"`, until the
 *    business itself has actually agreed to be shown.
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
  /** Path under `public/`. 1120×700 WebP, with a `-640` variant beside it. */
  image: string;
  /** Describes the image for anyone who cannot see it — not the project. */
  imageAlt: string;
  year: number;
};

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
    image: "/work/scott-mortensen-fine-arts.webp",
    imageAlt:
      "A bronze mountain lion sculpture by Scott Mortensen, shown mid-stride.",
    year: 2026,
  },
  {
    slug: "matts-seasonal-sales",
    name: "Matt's Seasonal Sales",
    sector: "Seasonal retail — pumpkin patch and tree lot",
    description:
      "A pitch build for a seasonal retail lot: patch hours, the games and photo spots on site, and a tree-lot section that swaps in once pumpkin season ends. Built to work from a phone in a gravel parking lot with one bar of signal.",
    domain: "matts-seasonal-sales-demo.netlify.app",
    href: "https://matts-seasonal-sales-demo.netlify.app",
    status: "concept",
    tags: ["Seasonal retail", "Mobile-first", "Pitch build"],
    image: "/work/matts-seasonal-sales.webp",
    imageAlt: "A pumpkin display tower at Matt's Seasonal Sales.",
    year: 2026,
  },
  {
    slug: "mitch-bedke-art",
    name: "Mitch Bedke Glass Art",
    sector: "Glass art studio",
    description:
      "A gallery pitch for a glass artist — full-bleed shots of fused and blown work, a studio story, and a commission path. Built to make the glass itself carry the page rather than a template layout.",
    domain: "mitch-bedke-art-demo.netlify.app",
    href: "https://mitch-bedke-art-demo.netlify.app",
    status: "concept",
    tags: ["Gallery site", "Photography-led", "Commission enquiries"],
    image: "/work/mitch-bedke-art.webp",
    imageAlt: "A fused glass panel by Mitch Bedke, lit from behind.",
    year: 2026,
  },
];

export const STATUS_LABEL: Record<WorkStatus, string> = {
  live: "Live",
  concept: "Concept",
  internal: "In-house",
};
