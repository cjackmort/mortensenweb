import { describe, expect, it } from "vitest";
import { backdropAttributes } from "@/components/noise-backdrop-settings";

/**
 * The backdrop is meant to be noticed only when someone looks for it. These
 * pin the settings that keep it that way — faint, transparent over the ground,
 * slow and cheap — so a later tweak cannot quietly turn it up.
 */

const EVERY_CASE = [
  backdropAttributes("auto", false),
  backdropAttributes("auto", true),
  backdropAttributes("dark", false),
  backdropAttributes("dark", true),
];

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

  it("stays faint and transparent over the ground in every case", () => {
    for (const attributes of EVERY_CASE) {
      expect(attributes.background).toBe("transparent");
      expect(Number(attributes.intensity)).toBeGreaterThan(0);
      expect(Number(attributes.intensity)).toBeLessThanOrEqual(0.15);
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
