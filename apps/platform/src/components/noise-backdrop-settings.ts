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

/**
 * The most of `intensity` the smoke ever reaches: its densest point over a
 * long run of frames, measured in the browser at these settings. The ground
 * under any pixel is tinted by at most `intensity` times this.
 */
export const PEAK_COVER = 0.73;

/**
 * `--accent-fill` in light; the site's `--accent` (blue on dark) in dark.
 *
 * Light is at 0.25 so the smoke is clear at a glance on the signed-in
 * pages. That tints the ground by at most 18%, which is why --muted went
 * one shade darker: it stays at 4.5:1 there.
 */
const ON_LIGHT = { color: "#1552d6", intensity: "0.25" } as const;
const ON_DARK = { color: "#7ea6ff", intensity: "0.1" } as const;

export function backdropAttributes(tone: BackdropTone, prefersDark: boolean): Record<string, string> {
  const onDark = tone === "dark" || prefersDark;
  return { ...SHARED, ...(onDark ? ON_DARK : ON_LIGHT) };
}
