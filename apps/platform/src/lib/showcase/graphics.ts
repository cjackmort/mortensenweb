import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Sharp, OverlayOptions } from "sharp";
import type { BrandColours } from "./brand";
import { formatSpec, type GraphicFormat, type GraphicFormatSpec } from "./formats";

/**
 * Rendering a showcase's social graphics with sharp.
 *
 * ## Text, without a browser and without system fonts
 *
 * The caption is drawn by sharp's own text renderer (Pango) from a font file
 * shipped in this repository, `assets/fonts/Geist-Regular.ttf` (SIL Open Font
 * License; licence beside it). Two cheaper-looking routes were ruled out:
 *
 *  - **System fonts.** A Netlify function has none to speak of, so text that
 *    renders on a laptop comes out as empty boxes in production.
 *  - **`next/og`.** It brings its own font and works anywhere, but it is
 *    2.5 MB of WASM and JavaScript added to the one server function every
 *    page shares, which #115 had just halved.
 *
 * The font is read from `process.cwd()`: Netlify's handler changes into the
 * app directory before serving, and `outputFileTracingIncludes` in
 * `next.config.ts` puts the file in the function. If it is ever missing the
 * renderer throws and says where it looked, rather than drawing a graphic
 * with no words on it.
 *
 * ## Layout
 *
 * The photo fills the top, cropped with sharp's attention strategy so the busy
 * part of a job photo survives a square crop. The band below carries the
 * caption and the business name in the brand colour, with a strip of the
 * accent colour along its top edge. A before-and-after pair splits the photo
 * area: side by side in a square, stacked in the taller formats.
 *
 * No metadata is written. These are going onto public social accounts, and a
 * phone photo's GPS position is a customer's home.
 */

const FONT_RELATIVE = "assets/fonts/Geist-Regular.ttf";
const FONT_FAMILY = "Geist";
/** Pango sizes in points; at 72 dpi a point is a pixel. */
const DPI = 72;
const JPEG_QUALITY = 88;
const ACCENT_STRIP = 8;

export interface GraphicInput {
  format: GraphicFormat;
  /** Encoded image bytes. With `pair`, the first is before and the second after. */
  photos: Uint8Array[];
  pair?: boolean;
  caption: string;
  businessName: string;
  brand: BrandColours;
}

async function loadSharp() {
  const mod = await import("sharp");
  return mod.default;
}

function fontFile(): string {
  const path = join(process.cwd(), FONT_RELATIVE);
  if (!existsSync(path)) {
    throw new Error(`Showcase graphics font not found at ${path}. Is it in outputFileTracingIncludes?`);
  }
  return path;
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Rendered {
  input: Buffer;
  width: number;
  height: number;
}

async function textBlock(
  text: string,
  options: { size: number; colour: string; width: number; alphaPercent?: number },
): Promise<Rendered> {
  const sharp = await loadSharp();
  const alpha = options.alphaPercent ? ` alpha="${options.alphaPercent}%"` : "";
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${options.colour}"${alpha}>${escapeMarkup(text)}</span>`,
      font: `${FONT_FAMILY} ${options.size}`,
      fontfile: fontFile(),
      width: options.width,
      wrap: "word",
      rgba: true,
      dpi: DPI,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

async function fitPhoto(bytes: Uint8Array, width: number, height: number): Promise<Buffer> {
  const sharp = await loadSharp();
  return (sharp(bytes as unknown as Buffer) as Sharp)
    // EXIF orientation applied, so a phone photo is not composited sideways.
    .rotate()
    .resize(width, height, { fit: "cover", position: sharp.strategy.attention })
    .removeAlpha()
    .png()
    .toBuffer();
}

async function solid(width: number, height: number, colour: string): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer();
}

/** "Before" / "After", on a pill in the brand colour. */
async function label(text: string, brand: BrandColours, scale: number): Promise<Rendered> {
  const sharp = await loadSharp();
  const words = await textBlock(text, { size: Math.round(30 * scale), colour: brand.onPrimary, width: 400 });
  const padX = Math.round(18 * scale);
  const padY = Math.round(8 * scale);
  const width = words.width + padX * 2;
  const height = words.height + padY * 2;
  const pill = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="${Math.round(height / 2)}" fill="${brand.primary}"/></svg>`,
  );
  const input = await sharp(pill)
    .composite([{ input: words.input, left: padX, top: padY }])
    .png()
    .toBuffer();
  return { input, width, height };
}

async function photoLayers(
  input: GraphicInput,
  spec: GraphicFormatSpec,
  areaHeight: number,
): Promise<OverlayOptions[]> {
  const W = spec.width;
  const scale = W / 1080;
  const isPair = input.pair === true && input.photos.length >= 2;

  if (!isPair) {
    return [{ input: await fitPhoto(input.photos[0]!, W, areaHeight), left: 0, top: 0 }];
  }

  // Side by side when the area is wider than tall, stacked otherwise.
  const sideBySide = W >= areaHeight;
  const half = sideBySide
    ? { width: Math.floor(W / 2), height: areaHeight }
    : { width: W, height: Math.floor(areaHeight / 2) };
  const second = sideBySide ? { left: W - half.width, top: 0 } : { left: 0, top: areaHeight - half.height };

  const layers: OverlayOptions[] = [
    { input: await fitPhoto(input.photos[0]!, half.width, half.height), left: 0, top: 0 },
    { input: await fitPhoto(input.photos[1]!, sideBySide ? W - half.width : W, sideBySide ? areaHeight : areaHeight - half.height), ...second },
  ];

  if (spec.overlay) {
    const inset = Math.round(32 * scale);
    const before = await label("Before", input.brand, scale);
    const after = await label("After", input.brand, scale);
    layers.push(
      { input: before.input, left: inset, top: inset },
      { input: after.input, left: second.left + inset, top: second.top + inset },
    );
  }
  return layers;
}

function captionSize(caption: string, scale: number): number {
  const base = caption.length <= 40 ? 64 : caption.length <= 64 ? 56 : 48;
  return Math.round(base * scale);
}

/** One graphic, as a JPEG. */
export async function renderGraphic(input: GraphicInput): Promise<Uint8Array> {
  if (input.photos.length === 0) throw new Error("A graphic needs a photo.");
  const sharp = await loadSharp();
  const spec = formatSpec(input.format);
  const W = spec.width;
  const H = spec.height;

  if (!spec.overlay) {
    const layers = await photoLayers(input, spec, H);
    const out = await sharp({ create: { width: W, height: H, channels: 3, background: input.brand.primary } })
      .composite(layers)
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return new Uint8Array(out);
  }

  const scale = W / 1080;
  const pad = Math.round(64 * scale);
  const gap = Math.round(18 * scale);
  const textWidth = W - pad * 2;

  const caption = await textBlock(input.caption, {
    size: captionSize(input.caption, scale),
    colour: input.brand.onPrimary,
    width: textWidth,
  });
  const name = await textBlock(input.businessName, {
    size: Math.round(32 * scale),
    colour: input.brand.onPrimary,
    width: textWidth,
    alphaPercent: 80,
  });

  const minimumBand = Math.round(H * 0.2);
  const bandHeight = Math.max(
    minimumBand,
    ACCENT_STRIP + pad + caption.height + gap + name.height + pad + spec.bottomSafe,
  );
  const photoHeight = H - bandHeight;
  const textTop = photoHeight + ACCENT_STRIP + pad;

  const layers: OverlayOptions[] = [
    ...(await photoLayers(input, spec, photoHeight)),
    { input: await solid(W, ACCENT_STRIP, input.brand.accent), left: 0, top: photoHeight },
    { input: caption.input, left: pad, top: textTop },
    { input: name.input, left: pad, top: textTop + caption.height + gap },
  ];

  const out = await sharp({ create: { width: W, height: H, channels: 3, background: input.brand.primary } })
    .composite(layers)
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return new Uint8Array(out);
}
