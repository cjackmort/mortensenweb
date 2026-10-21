/**
 * The public portfolio, shown in full on `/work`; the home page shows the
 * first three.
 *
 * Adding a site is meant to be one entry in this array plus an image in
 * `public/work/` — no component changes. Live client work first, then demos,
 * then our own.
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
  /**
   * One sentence, present tense, concrete, no adjectives that cannot be
   * checked. The cards are compared side by side, so they stay short.
   */
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
  /**
   * Refresh `image` from the site's own `/__preview/home-tile.png` at build
   * time. True for anything built by our pipeline, which publishes that tile
   * on every deploy; the committed image stays as the fallback and is what
   * ships until the site actually serves one. See scripts/sync-tiles.ts.
   */
  autoTile?: boolean;
  year: number;
};

export const WORK: Work[] = [
  {
    slug: "scott-mortensen-fine-arts",
    name: "Scott Mortensen Fine Arts",
    sector: "Bronze sculpture studio",
    description:
      "Gallery site for a western wildlife sculptor: full-bleed photography, a gallery that never crops a piece, and a commission enquiry form.",
    domain: "scottmortensenfinearts.com",
    href: "https://scottmortensenfinearts.com",
    status: "live",
    tags: ["Gallery site", "Photography-led", "Commission enquiries"],
    image: "/work/scott-mortensen-fine-arts.webp",
    imageAlt:
      "A bronze mountain lion sculpture by Scott Mortensen, shown mid-stride.",
    autoTile: true,
    year: 2026,
  },
  {
    slug: "mitch-bedke-art",
    name: "Mitch Bedke Glass Art",
    sector: "Glass art studio",
    description:
      "Gallery site for a glass artist: full-bleed shots of fused and blown work, the studio's story, and a commission path.",
    domain: "mitchbedkeart.com",
    href: "https://mitchbedkeart.com",
    status: "live",
    tags: ["Gallery site", "Photography-led", "Commission enquiries"],
    image: "/work/mitch-bedke-art.webp",
    imageAlt: "A fused glass panel by Mitch Bedke, lit from behind.",
    autoTile: true,
    year: 2026,
  },
  // Graci gave the operator permission to show this, as a demo only
  // (operator, 2026-10-21) — so it stays `concept` and is labelled "Demo".
  // No `autoTile`: the site does not publish /__preview/home-tile.png, so the
  // image is a screenshot of its home page taken that day.
  {
    slug: "hair-by-graci",
    name: "Hair by Graci",
    sector: "Hair stylist",
    description:
      "Booking site for a hair stylist: clients pick one of the week's openings and say what they want done, and Graci confirms from her dashboard.",
    domain: "hair-by-graci.netlify.app",
    href: "https://hair-by-graci.netlify.app",
    status: "concept",
    tags: ["Online booking", "Weekly openings", "Owner dashboard"],
    image: "/work/hair-by-graci.webp",
    imageAlt:
      "The Hair by Graci home page: the name in large black and red script type over a photo of Graci in a black dress.",
    year: 2026,
  },
  // Ours, and last on purpose. It goes in as `internal` because it is not a
  // client engagement, and it sits below the client work because this page
  // exists to show what we do for other people.
  {
    slug: "jack-mortensen-portfolio",
    name: "Jack Mortensen Portfolio",
    sector: "Mechanical engineering portfolio",
    description:
      "Portfolio for a mechanical engineering student: the featured project's CAD assembly loads as a 3D model you can drag to rotate.",
    domain: "jackmortensenportfolio.netlify.app",
    href: "https://jackmortensenportfolio.netlify.app",
    status: "internal",
    tags: ["Portfolio", "3D in the browser", "Single page"],
    image: "/work/jack-mortensen-portfolio.webp",
    imageAlt:
      "The portfolio home page: the name in large white type over a dark, marbled fluid background.",
    year: 2026,
  },
];

export const STATUS_LABEL: Record<WorkStatus, string> = {
  live: "Live",
  concept: "Demo",
  internal: "In-house",
};
