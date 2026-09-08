import type { SupportedFormat } from "./constants";

/**
 * Reading what an image actually is, from its own bytes.
 *
 * No dependency, on purpose. This runs in the request path at finalisation —
 * the moment an upload is accepted or refused — and that path should not need a
 * native binary to be loadable. `sharp` does the heavy work later, in the job,
 * where a cold start costs nobody a spinner.
 *
 * What this answers, and why each one matters:
 *
 *  - **Which format is this really?** The browser's declared type is a claim.
 *    A `.png` full of HTML is the attack; magic bytes are the answer.
 *  - **How large is it in pixels?** Needed to tell a client their photo is too
 *    small for a hero *before* the agent uses it, rather than after.
 *  - **Does it carry transparency?** A logo flattened onto black is a support
 *    conversation. Knowing means the derivative pipeline can keep PNG as PNG.
 *  - **How was the camera held?** EXIF orientation is why phone photos arrive
 *    sideways. Recorded here, applied when derivatives are generated.
 *
 * Every parser below is bounds-checked and gives up rather than throwing: a
 * malformed file must be *refused*, and a refusal is a return value.
 */

export interface ImageProbe {
  format: SupportedFormat;
  contentType: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  /** EXIF orientation 1-8; 1 when absent or unreadable. */
  orientation: number;
}

/**
 * Formats we can identify but deliberately do not accept.
 *
 * Naming them is the point. "That is a HEIC photo, which we cannot process
 * yet — turn on Most Compatible in your iPhone camera settings" is actionable;
 * "unsupported file type" sends someone to search the web.
 */
export type RejectedFormat = "heic" | "svg" | "bmp" | "tiff" | "avif" | "unknown";

export type SniffResult =
  | { ok: true; probe: ImageProbe }
  | { ok: false; detected: RejectedFormat };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/**
 * EXIF orientation, from the APP1 segment.
 *
 * Returns 1 — "as stored" — for anything it cannot read. A wrong orientation
 * rotates a client's photo incorrectly, which is worse than not rotating it, so
 * every uncertain path here resolves to doing nothing.
 */
function readJpegOrientation(
  bytes: Uint8Array,
  /** First byte *after* the segment length, where "Exif\0\0" begins. */
  payloadStart: number,
  /** Segment length as stored, which counts its own two bytes. */
  segmentLength: number,
): number {
  // APP1 payload: "Exif\0\0" then a TIFF header.
  if (ascii(bytes, payloadStart, 4) !== "Exif") return 1;

  const payloadEnd = payloadStart + segmentLength - 2;
  const tiff = payloadStart + 6;
  if (tiff + 8 > bytes.length || tiff + 8 > payloadEnd) return 1;

  const endian = ascii(bytes, tiff, 2);
  const little = endian === "II";
  if (!little && endian !== "MM") return 1;

  const read16 = (o: number) => (little ? bytes[o]! | (bytes[o + 1]! << 8) : u16be(bytes, o));
  const read32 = (o: number) =>
    little
      ? (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0
      : u32be(bytes, o);

  if (read16(tiff + 2) !== 0x002a) return 1;

  const ifdOffset = read32(tiff + 4);
  const ifd = tiff + ifdOffset;
  if (ifd + 2 > bytes.length) return 1;

  const entryCount = read16(ifd);
  // A plausible IFD, not a length taken on trust.
  if (entryCount > 512) return 1;

  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) return 1;
    if (read16(entry) !== 0x0112) continue;
    const value = read16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

function probeJpeg(bytes: Uint8Array): ImageProbe | null {
  let offset = 2;
  let orientation = 1;
  let width = 0;
  let height = 0;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: pixel data follows, and the dimensions are already behind
    // us if they were ever coming.
    if (marker === 0xda || marker === 0xd9) break;

    const length = u16be(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;

    if (marker === 0xe1 && orientation === 1) {
      // offset+2 is the length field; the payload starts two bytes after it.
      orientation = readJpegOrientation(bytes, offset + 4, length);
    }

    // SOF0-SOF15 hold the frame dimensions. C4 (Huffman tables), C8 (JPEG
    // extensions) and CC (arithmetic coding) share the range and do not.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      if (offset + 9 > bytes.length) break;
      height = u16be(bytes, offset + 5);
      width = u16be(bytes, offset + 7);
      break;
    }

    offset += 2 + length;
  }

  if (width <= 0 || height <= 0) return null;
  return {
    format: "jpeg",
    contentType: "image/jpeg",
    width,
    height,
    // JPEG has no alpha channel. Not "we did not check" — it cannot have one.
    hasAlpha: false,
    orientation,
  };
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function probePng(bytes: Uint8Array): ImageProbe | null {
  // Signature, then the IHDR chunk: length, type, width, height, depth, colour.
  if (bytes.length < 33) return null;
  if (ascii(bytes, 12, 4) !== "IHDR") return null;

  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  const colourType = bytes[25]!;
  if (width <= 0 || height <= 0) return null;

  // Colour types 4 (grey+alpha) and 6 (RGB+alpha) carry a channel. Types 0 and
  // 2 can still be transparent through a tRNS chunk, and a palette (3) almost
  // always is — so tRNS is looked for rather than assumed absent.
  let hasAlpha = colourType === 4 || colourType === 6;

  if (!hasAlpha) {
    // Walk the chunk list rather than searching the whole buffer for "tRNS",
    // which would also match those four bytes inside compressed pixel data.
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = u32be(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      if (type === "tRNS") {
        hasAlpha = true;
        break;
      }
      if (type === "IDAT" || type === "IEND") break;
      // 12 = length + type + CRC. Guard against a length that would wrap.
      if (length > bytes.length) break;
      offset += 12 + length;
    }
  }

  return {
    format: "png",
    contentType: "image/png",
    width,
    height,
    hasAlpha,
    orientation: 1,
  };
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

function probeGif(bytes: Uint8Array): ImageProbe | null {
  if (bytes.length < 10) return null;
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  if (width <= 0 || height <= 0) return null;
  return {
    format: "gif",
    contentType: "image/gif",
    width,
    height,
    // GIF transparency lives in a graphics control extension that may appear
    // per frame. Assumed present rather than parsed: the cost of assuming true
    // is that a derivative keeps an alpha channel it did not need, and the cost
    // of assuming false is a transparent logo flattened onto black.
    hasAlpha: true,
    orientation: 1,
  };
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

function probeWebp(bytes: Uint8Array): ImageProbe | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 8, 4) !== "WEBP") return null;

  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8X") {
    // Extended format: a flags byte, then canvas dimensions minus one.
    const hasAlpha = (bytes[20]! & 0x10) !== 0;
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    if (width <= 0 || height <= 0) return null;
    return { format: "webp", contentType: "image/webp", width, height, hasAlpha, orientation: 1 };
  }

  if (chunk === "VP8 ") {
    // Lossy. The keyframe start code sits at 23; dimensions are 14-bit values
    // immediately after it, with the top two bits used as a scale factor.
    if (bytes.length < 30) return null;
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return null;
    const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    // A bare VP8 chunk is lossy and has no alpha channel.
    return {
      format: "webp",
      contentType: "image/webp",
      width,
      height,
      hasAlpha: false,
      orientation: 1,
    };
  }

  if (chunk === "VP8L") {
    // Lossless. A 0x2f signature, then 14 bits of width-1, 14 of height-1, and
    // an alpha-used flag, packed little-endian across the following bytes.
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    const hasAlpha = ((bits >>> 28) & 1) === 1;
    if (width <= 0 || height <= 0) return null;
    return { format: "webp", contentType: "image/webp", width, height, hasAlpha, orientation: 1 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Identify an image from its bytes.
 *
 * Order matters only in that the rejected formats are checked alongside the
 * accepted ones rather than after them — the value of detecting HEIC is
 * entirely in the message it produces, so it must not fall through to
 * "unknown".
 */
export function sniffImageFormat(bytes: Uint8Array): SniffResult {
  if (bytes.length < 12) return { ok: false, detected: "unknown" };

  // --- Accepted -----------------------------------------------------------

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const probe = probeJpeg(bytes);
    return probe ? { ok: true, probe } : { ok: false, detected: "unknown" };
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const probe = probePng(bytes);
    return probe ? { ok: true, probe } : { ok: false, detected: "unknown" };
  }

  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    const probe = probeGif(bytes);
    return probe ? { ok: true, probe } : { ok: false, detected: "unknown" };
  }

  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const probe = probeWebp(bytes);
    return probe ? { ok: true, probe } : { ok: false, detected: "unknown" };
  }

  // --- Identified, and refused --------------------------------------------

  // ISO base media: "....ftyp" then a brand. HEIC and AVIF share the container.
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand.startsWith("avi")) return { ok: false, detected: "avif" };
    if (
      brand === "heic" ||
      brand === "heix" ||
      brand === "hevc" ||
      brand === "heim" ||
      brand === "heis" ||
      brand === "mif1" ||
      brand === "msf1"
    ) {
      return { ok: false, detected: "heic" };
    }
  }

  if (startsWith(bytes, [0x42, 0x4d])) return { ok: false, detected: "bmp" };
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { ok: false, detected: "tiff" };
  }

  // SVG is text, and may open with a comment, a declaration or the tag itself.
  const head = ascii(bytes, 0, Math.min(256, bytes.length)).trimStart().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype svg")) {
    return { ok: false, detected: "svg" };
  }

  return { ok: false, detected: "unknown" };
}

/**
 * What to tell someone whose file we refused.
 *
 * Each of these names the actual problem and, where there is one, the next
 * step. "Unsupported file type" is technically accurate and practically
 * useless, which is why none of these say it.
 */
export const REJECTION_EXPLANATIONS: Record<RejectedFormat, string> = {
  heic:
    "That is a HEIC photo, which we cannot process yet. On an iPhone, " +
    "Settings › Camera › Formats › Most Compatible makes the camera save JPEGs " +
    "instead — or open the photo and export it as JPEG and upload that.",
  avif: "AVIF images are not supported yet. A JPEG, PNG or WebP copy will work.",
  svg:
    "SVG files are not accepted. They can carry scripts, so we only take " +
    "photographic formats — JPEG, PNG, GIF or WebP.",
  bmp: "BMP files are not supported. Saving as PNG keeps the same quality and is accepted.",
  tiff:
    "TIFF files are not supported. Exporting as PNG keeps full quality, or as " +
    "JPEG for a smaller file.",
  unknown:
    "That file does not look like an image we can read. It may be damaged, or " +
    "it may not be an image at all. JPEG, PNG, GIF and WebP are accepted.",
};

/**
 * Pixel dimensions as they will be *seen*.
 *
 * EXIF orientations 5-8 involve a quarter turn, so the stored width becomes the
 * displayed height. Anywhere a number is shown to a client, or compared against
 * a minimum for an intended use, it has to be this one — otherwise a portrait
 * phone photo reports itself as landscape and a resolution check asks the wrong
 * question.
 */
export function displayDimensions(probe: {
  width: number;
  height: number;
  orientation: number | null;
}): { width: number; height: number } {
  const rotated = probe.orientation !== null && probe.orientation >= 5 && probe.orientation <= 8;
  return rotated
    ? { width: probe.height, height: probe.width }
    : { width: probe.width, height: probe.height };
}
