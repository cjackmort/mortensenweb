/**
 * The portal's ground: the portfolio site's marbled smoke, in the brand blue
 * and turned almost all the way down.
 *
 * Transparent, so it tints whatever ground sits under it rather than
 * replacing it, and a theme change only swaps the colour. Rendered at 40% of
 * the screen's resolution and 30 fps, because a field this soft looks the same
 * stretched and slowed, and it then costs almost nothing.
 */

/** "auto" follows the device's light/dark scheme; "dark" is the fixed-dark sign-in screens. */
export type BackdropTone = "auto" | "dark";

const SHARED = {
  preset: "smoke",
  background: "transparent",
  speed: "0.35",
  chroma: "0.6",
  fade: "3",
  resolution: "0.4",
  fps: "30",
} as const;

/** `--accent-fill` in light; the site's `--accent` (blue on dark) in dark. */
const ON_LIGHT = { color: "#1552d6", intensity: "0.12" } as const;
const ON_DARK = { color: "#7ea6ff", intensity: "0.1" } as const;

export function backdropAttributes(tone: BackdropTone, prefersDark: boolean): Record<string, string> {
  const onDark = tone === "dark" || prefersDark;
  return { ...SHARED, ...(onDark ? ON_DARK : ON_LIGHT) };
}
