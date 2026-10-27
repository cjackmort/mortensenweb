import type { AssetSummary } from "@/db/repositories/client/media-assets";
import type { PickablePhoto } from "./product-form";

/** The newest photos. The library is where you browse; this is for the piece just photographed. */
export const PICKER_LIMIT = 120;

/**
 * A failed upload can never be used; one still processing will be in a
 * moment, so it is shown, greyed, rather than hidden.
 */
export function pickablePhotos(assets: AssetSummary[]): PickablePhoto[] {
  return assets
    .filter((a) => a.status === "ready" || a.status === "processing")
    .map((a) => ({
      publicId: a.publicId,
      title: a.title ?? a.originalFilename,
      ready: a.status === "ready",
      hasThumbnail: a.hasThumbnail,
    }));
}
