import { crc32 } from "node:zlib";

/**
 * A zip of a few files, stored without compression.
 *
 * Written here rather than added as a dependency because what it needs is
 * small and fixed: four JPEGs and a text file. JPEGs do not compress, so
 * "stored" loses nothing, and without deflate a zip is a header per file and
 * a directory at the end — about fifty lines with Node's own `crc32`. No
 * ZIP64, so the whole archive stays under 4 GB, which four graphics always do.
 */

export interface ZipEntry {
  /** A plain file name. No folders, and nothing that climbs out of one. */
  name: string;
  bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
/** Version 2.0, and bit 11: names are UTF-8. */
const VERSION = 20;
const UTF8_FLAG = 0x0800;
/** 1980-01-01, the earliest date the format has. A fixed date keeps the output reproducible. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function assertSafeName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.includes("\0")) {
    throw new Error(`Refusing zip entry name "${name}".`);
  }
}

export function storeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeName(entry.name);
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes) >>> 0;
    const size = entry.bytes.byteLength;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, entry.bytes);
    centrals.push(central);
    offset += local.byteLength + size;
  }

  const directorySize = centrals.reduce((sum, c) => sum + c.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_DIRECTORY, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
