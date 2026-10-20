import { describe, expect, it } from "vitest";
import sharp from "sharp";
import decodeQR from "@paulmillr/qr/decode.js";
import { QUIET_ZONE_MODULES, qrMatrix, qrPathData, qrPng, qrSvg } from "@/lib/campaigns/qr";

/**
 * The printable QR codes.
 *
 * Every test here decodes what was produced rather than inspecting how it
 * was drawn: the only property a client cares about is that a phone held
 * up to the door hanger opens the right page.
 */

const URL_TEXT = "https://portal.mortensenweb.com/q/7kd2mx";

async function decodePng(png: Buffer): Promise<string> {
  const { data, info } = await sharp(png)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return decodeQR({ width: info.width, height: info.height, data: new Uint8Array(data) });
}

describe("QR matrix", () => {
  it("has a four-module quiet zone on every side, as the standard requires", () => {
    const matrix = qrMatrix(URL_TEXT);
    const size = matrix.length;
    for (let i = 0; i < QUIET_ZONE_MODULES; i += 1) {
      expect(matrix[i]!.every((dark) => !dark)).toBe(true);
      expect(matrix[size - 1 - i]!.every((dark) => !dark)).toBe(true);
      expect(matrix.every((row) => !row[i] && !row[size - 1 - i])).toBe(true);
    }
    // And the code itself starts straight after it: a finder pattern corner.
    expect(matrix[QUIET_ZONE_MODULES]![QUIET_ZONE_MODULES]).toBe(true);
  });
});

describe("PNG download", () => {
  it("decodes back to the short link", async () => {
    expect(await decodePng(await qrPng(URL_TEXT))).toBe(URL_TEXT);
  });

  it("is large enough to print sharply on a yard sign", async () => {
    const meta = await sharp(await qrPng(URL_TEXT)).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(2048);
    expect(meta.width).toBe(meta.height);
    // Whole pixels per module, so no module is blurred across a boundary.
    expect(meta.width! % qrMatrix(URL_TEXT).length).toBe(0);
  });

  it("states a print resolution, so layout software sizes it sensibly", async () => {
    const meta = await sharp(await qrPng(URL_TEXT)).metadata();
    expect(meta.density).toBe(300);
  });
});

describe("SVG download", () => {
  it("decodes back to the short link once rasterised", async () => {
    const png = await sharp(Buffer.from(qrSvg(URL_TEXT)), { density: 300 }).png().toBuffer();
    expect(await decodePng(png)).toBe(URL_TEXT);
  });

  it("is a self-contained vector with a white background and no script", () => {
    const svg = qrSvg(URL_TEXT);
    const size = qrMatrix(URL_TEXT).length;
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toMatch(/<script/i);
  });

  it("escapes the text it labels itself with", () => {
    expect(qrSvg("https://a.example/?a=1&b=<2>")).toContain("a=1&amp;b=&lt;2&gt;");
  });
});

describe("inline preview", () => {
  it("draws one path whose runs cover exactly the dark modules", () => {
    const matrix = qrMatrix(URL_TEXT);
    const dark = matrix.flat().filter(Boolean).length;
    const runs = [...qrPathData(matrix).matchAll(/M(\d+) (\d+)h(\d+)/g)];
    expect(runs.reduce((sum, run) => sum + Number(run[3]), 0)).toBe(dark);
    for (const [, x, y, length] of runs) {
      for (let i = 0; i < Number(length); i += 1) {
        expect(matrix[Number(y)]![Number(x) + i]).toBe(true);
      }
    }
  });
});
