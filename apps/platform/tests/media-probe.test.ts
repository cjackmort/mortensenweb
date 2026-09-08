import { describe, expect, it } from "vitest";
import {
  displayDimensions,
  REJECTION_EXPLANATIONS,
  sniffImageFormat,
} from "@/lib/media/probe";
import {
  corruptImageFixture,
  gifFixture,
  heicHeaderFixture,
  jpegFixture,
  opaquePngFixture,
  svgFixture,
  transparentPngFixture,
  truncatedPngFixture,
  webpFixture,
} from "./helpers/images";

/**
 * Format identification from bytes.
 *
 * These run against images produced by a real encoder, not hand-built headers,
 * because the parser has to survive what encoders actually emit — the optional
 * chunks, the metadata blocks, the padding — rather than the tidy minimum a
 * fixture author would write.
 */

describe("sniffImageFormat", () => {
  it("reads dimensions from a JPEG", async () => {
    const result = sniffImageFormat(new Uint8Array(await jpegFixture(800, 600)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.format).toBe("jpeg");
    expect(result.probe.width).toBe(800);
    expect(result.probe.height).toBe(600);
    expect(result.probe.hasAlpha).toBe(false);
  });

  it("recovers EXIF orientation from a rotated phone photo", async () => {
    // Orientation 6 is a portrait photo stored landscape — the single most
    // common reason an uploaded photo appears sideways.
    const result = sniffImageFormat(
      new Uint8Array(await jpegFixture(400, 300, { orientation: 6 })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.orientation).toBe(6);
  });

  it("defaults orientation to 1 when there is no EXIF block", async () => {
    const result = sniffImageFormat(new Uint8Array(await jpegFixture(120, 120)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.orientation).toBe(1);
  });

  it("detects a real alpha channel in a PNG", async () => {
    const result = sniffImageFormat(new Uint8Array(await transparentPngFixture(64, 48)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.format).toBe("png");
    expect(result.probe.width).toBe(64);
    expect(result.probe.height).toBe(48);
    expect(result.probe.hasAlpha).toBe(true);
  });

  it("does not claim alpha on an opaque PNG", async () => {
    const result = sniffImageFormat(new Uint8Array(await opaquePngFixture(32, 32)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.hasAlpha).toBe(false);
  });

  it("reads a lossy WebP", async () => {
    const result = sniffImageFormat(new Uint8Array(await webpFixture(300, 200)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.format).toBe("webp");
    expect(result.probe.width).toBe(300);
    expect(result.probe.height).toBe(200);
  });

  it("reads a WebP carrying transparency", async () => {
    const result = sniffImageFormat(
      new Uint8Array(await webpFixture(120, 90, { alpha: true })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.width).toBe(120);
    expect(result.probe.height).toBe(90);
    expect(result.probe.hasAlpha).toBe(true);
  });

  it("reads a lossless WebP", async () => {
    const result = sniffImageFormat(
      new Uint8Array(await webpFixture(150, 75, { lossless: true, alpha: true })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.width).toBe(150);
    expect(result.probe.height).toBe(75);
  });

  it("reads a GIF", async () => {
    const result = sniffImageFormat(new Uint8Array(await gifFixture(200, 100)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.format).toBe("gif");
    expect(result.probe.width).toBe(200);
    expect(result.probe.height).toBe(100);
  });

  it("refuses HTML wearing an image name, and does not guess a format", () => {
    const result = sniffImageFormat(new Uint8Array(corruptImageFixture()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detected).toBe("unknown");
  });

  it("refuses a truncated PNG rather than reporting nonsense dimensions", async () => {
    const result = sniffImageFormat(new Uint8Array(await truncatedPngFixture()));
    expect(result.ok).toBe(false);
  });

  it("names HEIC specifically so the client can be told what to do", () => {
    const result = sniffImageFormat(new Uint8Array(heicHeaderFixture()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detected).toBe("heic");
    // The value of detecting it is entirely in the message.
    expect(REJECTION_EXPLANATIONS.heic).toMatch(/Most Compatible/);
  });

  it("refuses SVG, which is a script host", () => {
    const result = sniffImageFormat(new Uint8Array(svgFixture()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detected).toBe("svg");
  });

  it("refuses an empty buffer", () => {
    expect(sniffImageFormat(new Uint8Array(0)).ok).toBe(false);
  });

  it("gives every refusal an explanation a person can act on", () => {
    for (const [format, message] of Object.entries(REJECTION_EXPLANATIONS)) {
      expect(message.length, format).toBeGreaterThan(40);
      expect(message, format).not.toMatch(/^unsupported file type\.?$/i);
    }
  });
});

describe("displayDimensions", () => {
  it("leaves an unrotated image alone", () => {
    expect(displayDimensions({ width: 800, height: 600, orientation: 1 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("swaps the axes for a quarter-turn orientation", () => {
    // A portrait phone photo stored landscape: 4032x3024 on disk, 3024x4032 to
    // a human. Reporting the stored pair would tell a client their portrait
    // photo is landscape.
    for (const orientation of [5, 6, 7, 8]) {
      expect(displayDimensions({ width: 4032, height: 3024, orientation })).toEqual({
        width: 3024,
        height: 4032,
      });
    }
  });

  it("treats a missing orientation as unrotated", () => {
    expect(displayDimensions({ width: 10, height: 20, orientation: null })).toEqual({
      width: 10,
      height: 20,
    });
  });
});
