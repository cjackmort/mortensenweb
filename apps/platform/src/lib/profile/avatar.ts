import { validateImageUpload, type UploadRejection } from "@/lib/storage";

/**
 * A profile picture, from whatever was chosen to what is stored.
 *
 * Every upload is checked by its bytes (not its claimed type), then cut to a
 * square and shrunk to one size, as WebP. One size and one format means the
 * top bar and the profile page serve the same small file, a 12 MB phone
 * photo costs a few kilobytes of storage, and nothing a browser could
 * misread (an SVG with script in it, say) ever reaches the store — sharp
 * only writes what it decoded.
 */

/** Edge of the stored square, in pixels. Twice the largest it is drawn, for sharp screens. */
export const AVATAR_EDGE = 256;

/**
 * Uploads above this are refused before any decoding. Under the 6 MB the
 * server action layer accepts (next.config.ts); the form shrinks a photo in
 * the browser first, so this is a ceiling, not the usual size.
 */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export type AvatarRejection = UploadRejection | "undecodable";

export const AVATAR_REJECTION_MESSAGES: Record<AvatarRejection, string> = {
  empty: "That file is empty. Choose a photo.",
  too_large: "That photo is over 5 MB. Choose a smaller one.",
  too_many: "Choose one photo.",
  unsupported_type: "Choose a JPEG, PNG, WebP or GIF.",
  content_mismatch: "That file isn't the kind of image it says it is.",
  undecodable: "That image couldn't be read. Try another photo.",
};

export interface PreparedAvatar {
  bytes: Uint8Array;
  contentType: "image/webp";
}

/**
 * Check the upload and produce the stored picture. `sharp` is imported here,
 * at call time, so a page that only shows an avatar never loads it.
 */
export async function prepareAvatar(
  file: File,
): Promise<{ ok: true; avatar: PreparedAvatar } | { ok: false; reason: AvatarRejection }> {
  if (file.size > MAX_AVATAR_BYTES) return { ok: false, reason: "too_large" };

  const checked = await validateImageUpload(file);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  try {
    const sharp = (await import("sharp")).default;
    const encoded = await sharp(checked.upload.bytes as unknown as Buffer)
      // Apply the EXIF orientation, then drop the tag: a phone photo is often
      // stored sideways and marked to be turned.
      .rotate()
      // Centre crop to a square, then one fixed size.
      .resize({ width: AVATAR_EDGE, height: AVATAR_EDGE, fit: "cover", position: "centre" })
      // No animation: a profile picture that moves is a distraction in a top bar.
      .webp({ quality: 84, effort: 4 })
      .toBuffer();
    return { ok: true, avatar: { bytes: new Uint8Array(encoded), contentType: "image/webp" } };
  } catch {
    return { ok: false, reason: "undecodable" };
  }
}

/** The part of a key that changes per upload: what a cached URL is told apart by. */
export function avatarVersion(key: string): string {
  return key.replace(/^.*-([0-9a-f]+)\.webp$/, "$1");
}

/** Where the signed-in person's own picture is served from, with the version so a new one is fetched. */
export function ownAvatarUrl(key: string): string {
  return `/dashboard/profile/avatar?v=${avatarVersion(key)}`;
}

/** The letters shown in place of a picture: initials of the name, or the first letter of the email. */
export function initialsFor(name: string | null, email: string): string {
  // Only words that start with a letter or digit count: "Dana Reyes (DEMO)"
  // is D and R, with the bracketed tag ignored rather than read as a surname.
  const words = (name ?? "").split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  if (words.length >= 2) return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return email.slice(0, 1).toUpperCase();
}
