/**
 * Shrinking a photo in the browser, before it is ever sent.
 *
 * A photo from a modern phone is 3–5 MB and four thousand pixels wide. Nothing
 * on a website needs that: the largest it will ever render is a hero at maybe
 * 1600px. Sending the original means a client on a phone signal waits through a
 * multi-megabyte upload, and — the reason this exists — the request exceeded the
 * server action's body limit, failed, and took everything they had typed with
 * it.
 *
 * Doing it client-side rather than server-side is the point. The bytes never
 * leave the device at full size, so the upload is fast on a bad connection and
 * the failure mode disappears rather than being handled.
 *
 * This is a convenience, not a control. The server still inspects the bytes of
 * whatever arrives — see `lib/storage` — because anything running in a browser
 * can be bypassed.
 */

/** Longest edge, in pixels. Above a hero's needs, below a phone's output. */
const MAX_EDGE = 1600;

/** JPEG quality. 0.82 is the point where artefacts stop being visible. */
const QUALITY = 0.82;

/** Below this, re-encoding costs more quality than it saves bytes. */
const SKIP_BELOW_BYTES = 400 * 1024;

export interface DownscaleResult {
  file: File;
  originalBytes: number;
  bytes: number;
}

export async function downscaleImage(file: File): Promise<DownscaleResult> {
  const original = file.size;

  // Leave small files, and anything that is not a raster image, alone. A GIF
  // re-encoded to JPEG loses its animation, which a client would notice and we
  // would not.
  if (file.size <= SKIP_BELOW_BYTES || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
    return { file, originalBytes: original, bytes: original };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

    // Already small enough in dimensions: re-encoding would only lose quality.
    if (scale === 1 && file.type === "image/jpeg") {
      bitmap.close();
      return { file, originalBytes: original, bytes: original };
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return { file, originalBytes: original, bytes: original };
    }

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );

    // If the result is somehow larger, keep the original. Re-encoding an
    // already-optimised image can do that, and shipping the worse of the two
    // would be an odd way to save bandwidth.
    if (!blob || blob.size >= file.size) {
      return { file, originalBytes: original, bytes: original };
    }

    const renamed = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return {
      file: new File([blob], renamed, { type: "image/jpeg" }),
      originalBytes: original,
      bytes: blob.size,
    };
  } catch {
    // A browser without `createImageBitmap`, a corrupt file, a canvas the OS
    // refused. Send the original and let the server decide — failing the whole
    // request because an optimisation did not work would be worse than the
    // slow upload it was meant to avoid.
    return { file, originalBytes: original, bytes: original };
  }
}
