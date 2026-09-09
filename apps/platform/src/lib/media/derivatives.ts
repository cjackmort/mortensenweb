import { DERIVATIVE_SPECS, type DerivativeKind } from "./constants";

/**
 * Generating the sizes a website actually uses.
 *
 * ## The rule everything else follows from
 *
 * **The original is never touched.** Every function here reads the original
 * bytes and returns new ones under a different key. There is no code path in
 * this file that writes to an original's key, and there must never be one — it
 * is the single promise the media library makes that the old attachment flow
 * could not.
 *
 * ## What is preserved, and what is deliberately discarded
 *
 * *Preserved:*
 *
 *  - **Transparency.** An image with an alpha channel produces WebP, which
 *    keeps it. Flattening a logo onto white is the sort of damage nobody
 *    notices until it is on a live site.
 *  - **Orientation.** `sharp().rotate()` with no argument applies the EXIF
 *    orientation and then clears the tag, so the pixels come out the way the
 *    photo was taken. This is why phone photos stop arriving sideways.
 *  - **Animation.** An animated GIF is read with `animated: true` and written as
 *    animated WebP, so a moving image does not silently become a still.
 *
 * *Discarded, on purpose:*
 *
 *  - **All other metadata.** `sharp` writes none unless asked, and it is not
 *    asked. That removes GPS coordinates, camera serial numbers, and any
 *    software history from every derivative — which matters because these are
 *    the files that end up on a public website. A photo of a product taken at
 *    someone's home should not publish their home's coordinates.
 *
 * The original keeps its metadata intact, because it is the client's file and
 * private to their library. That asymmetry is the point: the archive is
 * faithful, the published copy is clean.
 */

export interface DerivativeOutput {
  kind: DerivativeKind;
  bytes: Uint8Array;
  contentType: string;
  extension: string;
  width: number;
  height: number;
}

export interface DerivativeFailure {
  kind: DerivativeKind;
  message: string;
}

export interface DerivativeRun {
  outputs: DerivativeOutput[];
  failures: DerivativeFailure[];
  /** Dimensions after orientation is applied — what a person sees. */
  sourceWidth: number;
  sourceHeight: number;
  hasAlpha: boolean;
  isAnimated: boolean;
}

/**
 * Imported at call time rather than at module scope.
 *
 * `sharp` loads a native binary. Pulling it into the module graph of anything
 * that merely *imports* a type from here would put a several-megabyte
 * initialisation on the critical path of a request that does no image work.
 * Only the job runner reaches this line.
 */
async function loadSharp() {
  const mod = await import("sharp");
  return mod.default;
}

/**
 * Produce every derivative for one original.
 *
 * Per-size failures are collected rather than thrown. One size failing — an
 * odd aspect ratio, a codec refusing a dimension — should not cost the other
 * four, and a partial set is still a usable library entry. The caller decides
 * what an incomplete set means; `deriveAll` only reports.
 */
export async function deriveAll(original: Uint8Array): Promise<DerivativeRun> {
  const sharp = await loadSharp();

  const probe = sharp(original as unknown as Buffer);
  const metadata = await probe.metadata();

  const isAnimated = (metadata.pages ?? 1) > 1;
  const hasAlpha = metadata.hasAlpha === true;

  // Dimensions as displayed. `metadata.width` is the stored width, which for
  // orientations 5-8 is the *height* once the rotation is applied — the same
  // trap `displayDimensions` exists for on the probe side.
  const rotated =
    metadata.orientation !== undefined &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8;
  const sourceWidth = (rotated ? metadata.height : metadata.width) ?? 0;
  const sourceHeight = (rotated ? metadata.width : metadata.height) ?? 0;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("The image reported no usable dimensions.");
  }

  const outputs: DerivativeOutput[] = [];
  const failures: DerivativeFailure[] = [];

  for (const spec of DERIVATIVE_SPECS) {
    try {
      const output = await deriveOne(original, spec.kind, spec.maxEdge, {
        hasAlpha,
        isAnimated,
      });
      outputs.push(output);
    } catch (error) {
      failures.push({
        kind: spec.kind,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { outputs, failures, sourceWidth, sourceHeight, hasAlpha, isAnimated };
}

async function deriveOne(
  original: Uint8Array,
  kind: DerivativeKind,
  maxEdge: number,
  options: { hasAlpha: boolean; isAnimated: boolean },
): Promise<DerivativeOutput> {
  const sharp = await loadSharp();

  const pipeline = sharp(original as unknown as Buffer, {
    // Reads every frame, so an animated source stays animated.
    animated: options.isAnimated,
  })
    // No argument: apply the EXIF orientation, then drop the tag.
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      // Never enlarge. Upscaling produces a soft image that reads as our
      // mistake; the client is warned about low resolution instead and decides.
      withoutEnlargement: true,
    });

  // WebP throughout: it carries alpha, animates, and compresses better than
  // both JPEG and PNG at the qualities a website needs. One output format also
  // means one content type to serve and one thing to reason about.
  const encoded = await pipeline
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  return {
    kind,
    bytes: new Uint8Array(encoded.data),
    contentType: "image/webp",
    extension: "webp",
    width: encoded.info.width,
    // An animated WebP reports the height of all frames stacked. The frame
    // height is what a page lays out against, so it is what gets recorded.
    height: options.isAnimated
      ? Math.round(encoded.info.height / Math.max(1, encoded.info.pages ?? 1))
      : encoded.info.height,
  };
}
