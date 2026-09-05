/**
 * Pull each work card's image from the site it links to, at build time.
 *
 * Every site built by the pipeline publishes a screenshot of its own home page
 * at `/__preview/home-tile.png` — 1280x720, rewritten on every deploy by
 * agent/verify/screenshot.mjs. The portal's client grid already reads it. This
 * does the same for the public work page, so a client's card shows what their
 * site looks like today instead of a PNG someone exported once and forgot.
 *
 * Why at build time rather than pointing the <img> straight at the tile:
 *
 *   - This site is a static export that ships no JavaScript. A cross-origin
 *     <img> per card puts our marketing page's rendering on the critical path
 *     of somebody else's host.
 *   - The tile is a 1280x720 PNG; the cards want WebP at two widths. Converting
 *     here keeps the page's weight roughly where it is rather than adding a
 *     megabyte of screenshots.
 *
 * Failure is never fatal, deliberately. A missing tile, a slow host, or a site
 * that has not yet been moved onto the shared deploy workflow all leave the
 * committed image in place and let the build continue. A marketing site that
 * refuses to deploy because a client's host blipped would be a worse bug than
 * a stale thumbnail.
 *
 * Output is written as `<slug>-auto.webp` beside the committed image and is
 * gitignored. Leaving the committed file untouched is what makes the fallback
 * work, and generated images do not belong in the repository.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { WORK } from "../src/data/work";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.join(HERE, "..", "public", "work");

/** The path every pipeline-built site publishes. Mirrors TILE_PATH in the portal. */
const TILE_PATH = "/__preview/home-tile.png";

/** Must match the committed images, and so the width/height on WorkCard's <img>. */
const LARGE = { w: 1120, h: 700 };
const SMALL = { w: 640, h: 400 };

/** Long enough for a cold edge, short enough not to stall a deploy. */
const TIMEOUT_MS = 15_000;

/** A tile is a few hundred KB. An order of magnitude past that is not a tile. */
const MAX_BYTES = 8 * 1024 * 1024;

type Fetched = { url: string; buffer: Buffer } | { url: string; skip: string };

async function fetchTile(href: string): Promise<Fetched> {
  const url = new URL(TILE_PATH, href.endsWith("/") ? href : `${href}/`).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) return { url, skip: `HTTP ${response.status}` };

    // A host with an SPA fallback answers 200 with HTML for a missing file, so
    // the content type is the check that actually means anything here.
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      return { url, skip: `not an image (${type.split(";")[0] || "no content-type"})` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) return { url, skip: "empty response" };
    if (buffer.byteLength > MAX_BYTES) {
      return { url, skip: `${Math.round(buffer.byteLength / 1024)} KB is larger than a tile should be` };
    }
    return { url, buffer };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { url, skip: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `position: "top"` rather than centre: a home page's identity is its header
 * and hero. Centring a 16:9 screenshot into a 1.6:1 card trims from the top,
 * which is the half worth keeping.
 */
async function writeVariants(slug: string, buffer: Buffer): Promise<string> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("could not decode the image");

  const base = path.join(WORK_DIR, `${slug}-auto`);
  const large = await sharp(buffer)
    .resize(LARGE.w, LARGE.h, { fit: "cover", position: "top" })
    .webp({ quality: 82 })
    .toBuffer();
  const small = await sharp(buffer)
    .resize(SMALL.w, SMALL.h, { fit: "cover", position: "top" })
    .webp({ quality: 82 })
    .toBuffer();

  // Both or neither: a half-written pair would give the card a srcset entry
  // pointing at a file that does not exist.
  await writeFile(`${base}.webp`, large);
  await writeFile(`${base}-640.webp`, small);
  return `${meta.width}x${meta.height}`;
}

async function clearStale(slug: string): Promise<void> {
  await rm(path.join(WORK_DIR, `${slug}-auto.webp`), { force: true });
  await rm(path.join(WORK_DIR, `${slug}-auto-640.webp`), { force: true });
}

async function main(): Promise<void> {
  await mkdir(WORK_DIR, { recursive: true });

  const entries = WORK.filter((work) => work.autoTile);
  if (entries.length === 0) {
    console.log("[tiles] nothing opted in; every card keeps its committed image");
    return;
  }

  for (const work of entries) {
    const result = await fetchTile(work.href);

    if ("skip" in result) {
      // Drop any previous auto image so a site that stops publishing a tile
      // falls back to its committed one instead of showing a stale screenshot.
      await clearStale(work.slug);
      console.log(`[tiles] ${work.slug}: committed image — ${result.skip}`);
      continue;
    }

    try {
      const dims = await writeVariants(work.slug, result.buffer);
      console.log(`[tiles] ${work.slug}: refreshed from its ${dims} tile`);
    } catch (error) {
      await clearStale(work.slug);
      console.log(
        `[tiles] ${work.slug}: committed image — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  // Never fail the build. See the header.
  console.log(`[tiles] skipped: ${error instanceof Error ? error.message : String(error)}`);
});
