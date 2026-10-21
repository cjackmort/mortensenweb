import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { brandColours } from "@/lib/showcase/brand";
import { GRAPHIC_FORMATS, isGraphicFormat } from "@/lib/showcase/formats";
import { renderGraphic } from "@/lib/showcase/graphics";
import { storeZip } from "@/lib/showcase/zip";
import { jpegFixture } from "./helpers/images";

/**
 * The social graphics, rendered for real with sharp. Pixel checks are coarse
 * on purpose — the band's colour at its centre, the photo's colour at the
 * top — because they are what a wrong layout breaks, and finer checks would
 * break on a font update.
 */

async function pixel(bytes: Uint8Array, x: number, y: number) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
}

function near(actual: { r: number; g: number; b: number }, hex: string, tolerance = 24) {
  const n = Number.parseInt(hex.slice(1), 16);
  const want = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  return (
    Math.abs(actual.r - want.r) <= tolerance &&
    Math.abs(actual.g - want.g) <= tolerance &&
    Math.abs(actual.b - want.b) <= tolerance
  );
}

describe("brandColours", () => {
  it("reads hex colours from General information's brand notes", () => {
    const brand = brandColours({ brand: "Navy #1F3A5F with orange #f28c28 accents. Logo is the wordmark." });
    expect(brand).toMatchObject({ primary: "#1f3a5f", accent: "#f28c28", fromProfile: true });
  });

  it("expands a three-digit colour", () => {
    expect(brandColours({ brand: "#fa0" }).primary).toBe("#ffaa00");
  });

  it("falls back to dark grey and says so when there are none", () => {
    expect(brandColours({ brand: "blue and white" })).toMatchObject({ fromProfile: false, primary: "#1f2933" });
    expect(brandColours({})).toMatchObject({ fromProfile: false });
  });

  it("puts dark text on a light brand colour and light text on a dark one", () => {
    expect(brandColours({ brand: "#ffe066" }).onPrimary).toBe("#111111");
    expect(brandColours({ brand: "#1f3a5f" }).onPrimary).toBe("#ffffff");
  });
});

describe("renderGraphic", () => {
  const brand = brandColours({ brand: "#1f3a5f #f28c28" });

  it.each(GRAPHIC_FORMATS.map((f) => [f.key, f.width, f.height] as const))(
    "renders %s at %ix%i as a JPEG",
    async (key, width, height) => {
      const photo = await jpegFixture(1600, 1200);
      const bytes = await renderGraphic({
        format: key,
        photos: [photo],
        caption: "Replaced a furnace in Riverton",
        businessName: "Northwind Comfort Systems",
        brand,
      });
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(width);
      expect(meta.height).toBe(height);
    },
    20_000,
  );

  it("puts the photo at the top and the brand band at the bottom", async () => {
    const photo = await jpegFixture(1600, 1200); // rgb(30, 90, 160)
    const bytes = await renderGraphic({
      format: "square",
      photos: [photo],
      caption: "Replaced a furnace",
      businessName: "Northwind",
      brand,
    });
    expect(near(await pixel(bytes, 540, 100), "#1e5aa0")).toBe(true);
    // Left edge of the band, clear of the text.
    expect(near(await pixel(bytes, 8, 1070), brand.primary)).toBe(true);
  }, 20_000);

  it("leaves the Google image as the plain photo, with no text on it", async () => {
    const photo = await jpegFixture(1600, 1200);
    const bytes = await renderGraphic({
      format: "google",
      photos: [photo],
      caption: "Replaced a furnace",
      businessName: "Northwind",
      brand,
    });
    expect(near(await pixel(bytes, 600, 880), "#1e5aa0")).toBe(true);
  }, 20_000);

  it("splits a before and after pair across the frame", async () => {
    const before = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
    const after = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#00ff00" } }).jpeg().toBuffer();
    const square = await renderGraphic({ format: "square", photos: [before, after], pair: true, caption: "A", businessName: "B", brand });
    expect(near(await pixel(square, 270, 300), "#ff0000", 40)).toBe(true);
    expect(near(await pixel(square, 810, 300), "#00ff00", 40)).toBe(true);

    const story = await renderGraphic({ format: "story", photos: [before, after], pair: true, caption: "A", businessName: "B", brand });
    expect(near(await pixel(story, 540, 450), "#ff0000", 40)).toBe(true);
    expect(near(await pixel(story, 540, 1100), "#00ff00", 40)).toBe(true);
  }, 30_000);

  it("knows its formats", () => {
    expect(isGraphicFormat("square")).toBe(true);
    expect(isGraphicFormat("../etc/passwd")).toBe(false);
  });
});

/** A minimal reader: enough to prove another tool would find these entries intact. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.byteLength - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const data = bytes.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(crc);
    entries.push({ name, data });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

describe("storeZip", () => {
  it("writes entries another reader can find, byte for byte", () => {
    const files = [
      { name: "square.jpg", bytes: new Uint8Array([1, 2, 3, 4]) },
      { name: "caption.txt", bytes: new TextEncoder().encode("Replaced a furnace in Riverton.") },
    ];
    const entries = readZip(storeZip(files));
    expect(entries.map((e) => e.name)).toEqual(["square.jpg", "caption.txt"]);
    expect([...entries[0]!.data]).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("Replaced a furnace in Riverton.");
  });

  it("refuses a name that would escape the folder it is unpacked into", () => {
    expect(() => storeZip([{ name: "../evil.jpg", bytes: new Uint8Array([1]) }])).toThrow();
  });
});
