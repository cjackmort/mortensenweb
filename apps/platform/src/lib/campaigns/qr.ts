import encodeQR from "@paulmillr/qr";
import sharp from "sharp";

/**
 * Print-ready QR codes for a campaign's short link.
 *
 * `@paulmillr/qr` gives the module matrix and nothing else; both files are
 * drawn from that matrix here, so the SVG and the PNG are the same code and
 * the quiet zone is exactly what the standard asks for.
 */

/**
 * ISO/IEC 18004 asks for four modules of light margin. Printers trim to the
 * edge of the artwork, so a code supplied without its own margin is often
 * printed hard against a coloured background — and a phone cannot find a
 * code whose edge it cannot see.
 */
export const QUIET_ZONE_MODULES = 4;

/**
 * Quartile: a quarter of the code can be lost and it still scans. Yard
 * signs get muddy and truck lettering gets scratched; the link is short, so
 * the extra redundancy costs only a slightly denser code.
 */
const ERROR_CORRECTION = "quartile" as const;

/** At 300 dpi, about 17 cm across — more than any door hanger needs. */
const MIN_PNG_PIXELS = 2048;
const PRINT_DPI = 300;
/** The SVG's nominal size per module. It is a vector; this only sets the default. */
const SVG_PIXELS_PER_MODULE = 16;

export function qrMatrix(text: string): boolean[][] {
  return encodeQR(text, "raw", { ecc: ERROR_CORRECTION, border: QUIET_ZONE_MODULES }).map((row) =>
    row.map((cell) => cell === true),
  );
}

/**
 * The dark modules as one SVG path, a rectangle per horizontal run.
 *
 * One `<path>` rather than a `<rect>` per module keeps the file small and,
 * with `crispEdges`, avoids the hairline seams some renderers draw between
 * touching rectangles.
 */
export function qrPathData(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      const length = x - start;
      parts.push(`M${start} ${y}h${length}v1h-${length}z`);
    }
  });
  return parts.join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A self-contained SVG: white background included, so it prints on anything. */
export function qrSvg(text: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const pixels = size * SVG_PIXELS_PER_MODULE;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges">`,
    `<title>${escapeXml(text)}</title>`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path fill="#000000" d="${qrPathData(matrix)}"/>`,
    "</svg>",
    "",
  ].join("\n");
}

/**
 * A greyscale PNG with a whole number of pixels per module, so no module
 * edge is anti-aliased into grey, and a 300 dpi tag so layout software
 * places it at a sensible size instead of 28 inches across.
 */
export async function qrPng(text: string): Promise<Buffer> {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const scale = Math.ceil(MIN_PNG_PIXELS / size);
  const width = size * scale;
  const pixels = Buffer.alloc(width * width, 255);

  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy += 1) {
        const start = (y * scale + dy) * width + x * scale;
        pixels.fill(0, start, start + scale);
      }
    });
  });

  return sharp(pixels, { raw: { width, height: width, channels: 1 } })
    .withMetadata({ density: PRINT_DPI })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
