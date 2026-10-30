import { describe, expect, it } from "vitest";
import {
  MAX_CHOSEN_BYTES,
  MAX_ZOOM,
  checkChosenFile,
  cropRect,
  initialCrop,
  panCrop,
  previewStyle,
  zoomCrop,
} from "@/app/dashboard/profile/crop";

/**
 * Positioning a new profile picture in its circle before it is sent.
 *
 * What would go wrong quietly: a crop that reaches past the photo's edge
 * (a black bar in the saved picture), a preview that shows one square and
 * saves another, or a wrong kind of file reaching the server with a vague
 * error instead of being named before anything is uploaded.
 */

const landscape = { width: 1200, height: 800 };
const portrait = { width: 600, height: 900 };

describe("the starting crop", () => {
  it("is the largest square in the middle of the photo", () => {
    expect(cropRect(landscape, initialCrop(landscape))).toEqual({ x: 200, y: 0, size: 800 });
    expect(cropRect(portrait, initialCrop(portrait))).toEqual({ x: 0, y: 150, size: 600 });
  });
});

describe("dragging", () => {
  it("moves the photo with the pointer, at the circle's scale", () => {
    // 800 source pixels shown in a 200px circle: 1px of drag is 4 source pixels.
    // Dragging the photo right shows more of its left side.
    const moved = panCrop(landscape, initialCrop(landscape), 25, 0, 200);
    expect(cropRect(landscape, moved)).toEqual({ x: 100, y: 0, size: 800 });
  });

  it("stops at the photo's edge rather than showing past it", () => {
    const far = panCrop(landscape, initialCrop(landscape), 10_000, -10_000, 200);
    expect(cropRect(landscape, far)).toEqual({ x: 0, y: 0, size: 800 });
    const other = panCrop(landscape, initialCrop(landscape), -10_000, 10_000, 200);
    expect(cropRect(landscape, other)).toEqual({ x: 400, y: 0, size: 800 });
  });
});

describe("zooming", () => {
  it("narrows the square around the same point", () => {
    const zoomed = zoomCrop(landscape, initialCrop(landscape), 2);
    expect(cropRect(landscape, zoomed)).toEqual({ x: 400, y: 200, size: 400 });
  });

  it("keeps the square inside the photo when zooming back out near an edge", () => {
    const corner = panCrop(landscape, zoomCrop(landscape, initialCrop(landscape), 2), 10_000, 10_000, 200);
    expect(cropRect(landscape, corner)).toEqual({ x: 0, y: 0, size: 400 });
    expect(cropRect(landscape, zoomCrop(landscape, corner, 1))).toEqual({ x: 0, y: 0, size: 800 });
  });

  it("stays between showing the whole short side and the closest zoom", () => {
    expect(zoomCrop(landscape, initialCrop(landscape), 0.2).zoom).toBe(1);
    expect(zoomCrop(landscape, initialCrop(landscape), 99).zoom).toBe(MAX_ZOOM);
  });
});

describe("the preview", () => {
  it("places the photo so the circle shows exactly the square that will be saved", () => {
    const crop = zoomCrop(landscape, initialCrop(landscape), 2);
    // A 400px square of a 1200px-wide photo: the photo is 3 circles wide,
    // shifted left by one circle and up by half of one.
    expect(previewStyle(landscape, crop)).toEqual({ width: "300%", left: "-100%", top: "-50%" });
  });
});

describe("checking the chosen file", () => {
  it("accepts the photo types the server accepts", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      expect(checkChosenFile({ type, size: 2_000_000 })).toBeNull();
    }
  });

  it("names what is wrong with anything else, before uploading", () => {
    expect(checkChosenFile({ type: "application/pdf", size: 1000 })).toBe("Choose a JPEG, PNG, WebP or GIF.");
    expect(checkChosenFile({ type: "image/svg+xml", size: 1000 })).toBe("Choose a JPEG, PNG, WebP or GIF.");
    expect(checkChosenFile({ type: "image/png", size: 0 })).toBe("That file is empty. Choose a photo.");
    expect(checkChosenFile({ type: "image/jpeg", size: MAX_CHOSEN_BYTES + 1 })).toBe(
      "That photo is over 20 MB. Choose a smaller one.",
    );
  });
});
