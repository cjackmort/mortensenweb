import { describe, expect, it } from "vitest";
import { backdropAttributes, PEAK_COVER } from "@/components/noise-backdrop-settings";

/**
 * The backdrop has to be visible and never cost anyone a word. These pin the
 * settings that keep it that way — transparent over the ground, slow and
 * cheap, and never tinted so far that muted text on the open ground drops
 * under WCAG AA — so a later tweak cannot quietly turn it up past that.
 */

const EVERY_CASE = [
  backdropAttributes("auto", false),
  backdropAttributes("auto", true),
  backdropAttributes("dark", false),
  backdropAttributes("dark", true),
];

/** The ground, --muted and --accent (links) from globals.css, light and dark. */
const LIGHT = { ground: "#f4f5f2", muted: "#555c6a", accent: "#1552d6" };
const DARK = { ground: "#0e1116", muted: "#97a0ac" };

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r = 0, g = 0, b = 0]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** The ground under the densest point of the smoke, blended as the browser does. */
const mostTinted = (ground: string, attributes: Record<string, string>) => {
  const tint = Number(attributes.intensity) * PEAK_COVER;
  const color = channels(attributes.color ?? "");
  return channels(ground).map((g, i) => g + ((color[i] ?? 0) - g) * tint);
};

describe("backdropAttributes", () => {
  it("uses the brand blue on the light ground", () => {
    expect(backdropAttributes("auto", false).color).toBe("#1552d6");
  });

  it("uses the blue-on-dark when the device is dark", () => {
    expect(backdropAttributes("auto", true).color).toBe("#7ea6ff");
  });

  it("uses the blue-on-dark on the fixed-dark sign-in screens whatever the device scheme", () => {
    expect(backdropAttributes("dark", false).color).toBe("#7ea6ff");
  });

  it("keeps muted text on the most-tinted light ground at 4.5:1", () => {
    const ground = mostTinted(LIGHT.ground, backdropAttributes("auto", false));
    expect(contrast(channels(LIGHT.muted), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps links on the most-tinted light ground at 4.5:1", () => {
    const ground = mostTinted(LIGHT.ground, backdropAttributes("auto", false));
    expect(contrast(channels(LIGHT.accent), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps muted text on the most-tinted dark ground at 4.5:1", () => {
    const ground = mostTinted(DARK.ground, backdropAttributes("auto", true));
    expect(contrast(channels(DARK.muted), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("stays transparent over the ground in every case", () => {
    for (const attributes of EVERY_CASE) {
      expect(attributes.background).toBe("transparent");
      expect(Number(attributes.intensity)).toBeGreaterThan(0);
    }
  });

  it("stays slow and cheap in every case", () => {
    for (const attributes of EVERY_CASE) {
      expect(Number(attributes.speed)).toBeLessThanOrEqual(0.5);
      expect(Number(attributes.resolution)).toBeLessThanOrEqual(0.5);
      expect(Number(attributes.fps)).toBeLessThanOrEqual(30);
    }
  });
});
