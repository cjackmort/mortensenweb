/**
 * Brand colours for the social graphics, from General information.
 *
 * General information keeps colours as free text ("Colours, fonts and logo
 * notes"), so this reads the hex values out of it — the first is the band,
 * the second the accent. Colour names are not guessed at: "navy" is a dozen
 * different blues, and a wrong one on every post is worse than a neutral one.
 * With no hex colour the graphics use dark grey, and the page says so, so the
 * client knows how to change it.
 */

export interface BrandColours {
  primary: string;
  accent: string;
  /** Readable text colour on `primary`. */
  onPrimary: string;
  /** False when General information gave no hex colour and these are the defaults. */
  fromProfile: boolean;
}

const DEFAULT_PRIMARY = "#1f2933";
const DEFAULT_ACCENT = "#ffffff";
const DARK_TEXT = "#111111";
const LIGHT_TEXT = "#ffffff";

/** Above this, white text on the colour is harder to read than near-black. */
const LIGHT_LUMINANCE = 0.4;

function expand(hex: string): string {
  const bare = hex.slice(1).toLowerCase();
  const full = bare.length === 3 ? bare.split("").map((c) => c + c).join("") : bare;
  return `#${full}`;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function brandColours(details: Record<string, string | undefined>): BrandColours {
  const found = (details.brand ?? "").match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [];
  const colours = found.map(expand);

  const primary = colours[0] ?? DEFAULT_PRIMARY;
  const accent = colours.find((c) => c !== primary) ?? DEFAULT_ACCENT;

  return {
    primary,
    accent,
    onPrimary: luminance(primary) > LIGHT_LUMINANCE ? DARK_TEXT : LIGHT_TEXT,
    fromProfile: colours.length > 0,
  };
}
