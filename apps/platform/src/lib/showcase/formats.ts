/**
 * The images a showcase produces.
 *
 * The three social sizes are the ones Instagram and Facebook actually crop
 * to: square for the feed, 4:5 portrait (the tallest the feed shows), and
 * 9:16 for stories and reels. The Google image is the photo alone at 4:3,
 * the ratio Google's post card shows, with no text on it — Google crops and
 * resizes post images itself, and text baked in can end up cut in half.
 */

export type GraphicFormat = "square" | "portrait" | "story" | "google";

export interface GraphicFormatSpec {
  key: GraphicFormat;
  label: string;
  /** Where it is meant to go, in the client's terms. */
  use: string;
  width: number;
  height: number;
  /** Caption, business name and brand band on the image. */
  overlay: boolean;
  /**
   * Height kept clear at the bottom, inside the band. Stories put a reply bar
   * over the last ~250px, so text there would be hidden.
   */
  bottomSafe: number;
}

export const GRAPHIC_FORMATS: readonly GraphicFormatSpec[] = [
  { key: "square", label: "Square", use: "Instagram and Facebook feed", width: 1080, height: 1080, overlay: true, bottomSafe: 0 },
  { key: "portrait", label: "Portrait", use: "Instagram feed, tallest it shows", width: 1080, height: 1350, overlay: true, bottomSafe: 0 },
  { key: "story", label: "Story", use: "Instagram and Facebook stories", width: 1080, height: 1920, overlay: true, bottomSafe: 260 },
];

export const GOOGLE_IMAGE: GraphicFormatSpec = {
  key: "google",
  label: "Google post image",
  use: "Google Business Profile post",
  width: 1200,
  height: 900,
  overlay: false,
  bottomSafe: 0,
};

const ALL: readonly GraphicFormatSpec[] = [...GRAPHIC_FORMATS, GOOGLE_IMAGE];

export function isGraphicFormat(value: unknown): value is GraphicFormat {
  return ALL.some((f) => f.key === value);
}

export function formatSpec(key: GraphicFormat): GraphicFormatSpec {
  return ALL.find((f) => f.key === key)!;
}

const FILENAME_SLUG_MAX = 60;

/** "riverton-furnace-square.jpg" — safe in a download header and a zip. */
export function graphicFilename(title: string, format: GraphicFormat): string {
  const full = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Cut back to the last whole word, so a long title does not end "unit-i".
  const slug =
    full.length <= FILENAME_SLUG_MAX ? full : full.slice(0, FILENAME_SLUG_MAX + 1).replace(/-[^-]*$/, "");
  return `${slug || "showcase"}-${format}.jpg`;
}
