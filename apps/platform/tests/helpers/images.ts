import sharp from "sharp";

/**
 * Real image fixtures, generated rather than committed.
 *
 * Checked-in binaries rot: nobody can review a diff of one, and nobody can tell
 * from the filename whether `transparent.png` still has an alpha channel.
 * Generating them means the fixture and its description cannot disagree, and
 * the test says in code exactly which property it depends on.
 */

/** An opaque JPEG. `orientation` writes a real EXIF tag when given. */
export async function jpegFixture(
  width: number,
  height: number,
  options: { orientation?: number } = {},
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 90, b: 160 },
    },
  });
  const withOrientation =
    options.orientation === undefined ? image : image.withMetadata({ orientation: options.orientation });
  return withOrientation.jpeg({ quality: 80 }).toBuffer();
}

/** A PNG with a genuine alpha channel — the transparency-preservation fixture. */
export async function transparentPngFixture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 0.35 },
    },
  })
    .png()
    .toBuffer();
}

/** A PNG with no alpha, to prove `hasAlpha` is read rather than assumed. */
export async function opaquePngFixture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
}

export async function webpFixture(
  width: number,
  height: number,
  options: { alpha?: boolean; lossless?: boolean } = {},
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: options.alpha ? 4 : 3,
      background: options.alpha
        ? { r: 0, g: 128, b: 0, alpha: 0.5 }
        : { r: 0, g: 128, b: 0 },
    },
  })
    .webp({ lossless: options.lossless ?? false })
    .toBuffer();
}

export async function gifFixture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 200, b: 0 } },
  })
    .gif()
    .toBuffer();
}

/**
 * Bytes that claim to be an image and are not.
 *
 * The `.png` name and the declared content type are both lies, which is the
 * point: the validator must reach its verdict from the bytes.
 */
export function corruptImageFixture(): Buffer {
  return Buffer.from("<html><script>alert(1)</script></html>", "utf8");
}

/** A truncated PNG: a valid signature over an unreadable file. */
export async function truncatedPngFixture(): Promise<Buffer> {
  const full = await opaquePngFixture(64, 64);
  return full.subarray(0, 20);
}

/**
 * A minimal HEIC header.
 *
 * Enough for format detection, which is all we do with HEIC — the whole
 * behaviour under test is that it is recognised by name and refused with an
 * explanation, never decoded.
 */
export function heicHeaderFixture(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(32, 0); // box size
  buffer.write("ftyp", 4, "ascii");
  buffer.write("heic", 8, "ascii");
  buffer.writeUInt32BE(0, 12); // minor version
  buffer.write("heicmif1", 16, "ascii"); // compatible brands
  return buffer;
}

/** An SVG, which is an image to a person and a script host to a browser. */
export function svgFixture(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8",
  );
}
