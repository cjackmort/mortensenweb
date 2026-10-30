/**
 * Positioning a new profile picture in its circle, before it is sent.
 *
 * The crop is a square of the photo, held as its centre and a zoom in the
 * photo's own pixels — not the screen's — so the same crop is drawn in the
 * dialog's preview and cut out for the upload whatever size the circle is on
 * screen. Every change goes through `clampCrop`, which keeps the square
 * inside the photo: a crop past an edge would save as a black bar.
 *
 * Pure arithmetic, so it is tested on its own; the dialog only wires pointer
 * and slider events to it.
 */

export interface ImageSize {
  width: number;
  height: number;
}

export interface Crop {
  /** 1 shows the whole short side of the photo; higher is closer. */
  zoom: number;
  /** The middle of the square, in the photo's pixels. */
  centerX: number;
  centerY: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Edge of the square sent to the server. It stores 256; twice that gives it room to resample. */
export const OUTPUT_EDGE = 512;

/** The types the server accepts (`AVATAR_REJECTION_MESSAGES` in lib/profile/avatar). */
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Largest original the browser will open. Above the server's 5 MB because
 * what is sent is the cropped square, a few dozen kilobytes; a phone photo
 * of 8–12 MB is normal and must not be refused.
 */
export const MAX_CHOSEN_BYTES = 20 * 1024 * 1024;

function bound(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Side of the square, in the photo's pixels. */
function side(image: ImageSize, zoom: number): number {
  return Math.min(image.width, image.height) / zoom;
}

export function clampCrop(image: ImageSize, crop: Crop): Crop {
  const zoom = bound(crop.zoom, MIN_ZOOM, MAX_ZOOM);
  const half = side(image, zoom) / 2;
  return {
    zoom,
    centerX: bound(crop.centerX, half, image.width - half),
    centerY: bound(crop.centerY, half, image.height - half),
  };
}

/** The largest square in the middle of the photo. */
export function initialCrop(image: ImageSize): Crop {
  return { zoom: MIN_ZOOM, centerX: image.width / 2, centerY: image.height / 2 };
}

/**
 * Drag the photo by `dx`, `dy` screen pixels inside a circle `viewport`
 * pixels across. The photo follows the pointer, so the square moves the
 * other way.
 */
export function panCrop(image: ImageSize, crop: Crop, dx: number, dy: number, viewport: number): Crop {
  const perPixel = side(image, crop.zoom) / viewport;
  return clampCrop(image, {
    ...crop,
    centerX: crop.centerX - dx * perPixel,
    centerY: crop.centerY - dy * perPixel,
  });
}

/** Zoom around the square's current middle. */
export function zoomCrop(image: ImageSize, crop: Crop, zoom: number): Crop {
  return clampCrop(image, { ...crop, zoom });
}

/** The square to cut out, in the photo's pixels, rounded to whole pixels. */
export function cropRect(image: ImageSize, crop: Crop): { x: number; y: number; size: number } {
  const clamped = clampCrop(image, crop);
  const size = side(image, clamped.zoom);
  return {
    x: Math.round(clamped.centerX - size / 2),
    y: Math.round(clamped.centerY - size / 2),
    size: Math.round(size),
  };
}

function percent(value: number): string {
  return `${Number(value.toFixed(3))}%`;
}

/**
 * Where to draw the whole photo inside a square frame so the frame shows
 * exactly the crop. Percentages of the frame, so it holds at any size; the
 * frame is square, so `top` as a percentage of its width is right too.
 */
export function previewStyle(image: ImageSize, crop: Crop): { width: string; left: string; top: string } {
  const clamped = clampCrop(image, crop);
  const size = side(image, clamped.zoom);
  return {
    width: percent((image.width / size) * 100),
    left: percent((-(clamped.centerX - size / 2) / size) * 100),
    top: percent((-(clamped.centerY - size / 2) / size) * 100),
  };
}

/**
 * Why a chosen file cannot be used, in the words the server would use, or
 * null when it can. Checked before anything is read or sent; the server
 * checks the bytes again whatever this says.
 */
export function checkChosenFile(file: { type: string; size: number }): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "Choose a JPEG, PNG, WebP or GIF.";
  if (file.size === 0) return "That file is empty. Choose a photo.";
  if (file.size > MAX_CHOSEN_BYTES) return "That photo is over 20 MB. Choose a smaller one.";
  return null;
}
