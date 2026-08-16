/**
 * Attachment storage.
 *
 * The deploy target is undecided (Cloudflare R2 bindings vs Netlify Blobs vs
 * the S3 API), so the *driver* is deliberately the only part that knows. Every
 * rule that protects us — what may be uploaded, how large, and what the stored
 * name is allowed to be — lives here, above the driver, so choosing a backend
 * later cannot accidentally drop a check.
 *
 * The threat model for a client upload is not "a big file". It is:
 *
 *  - **A file that executes.** An `.html` or `.svg` served from our origin runs
 *    script in our origin's context. The allowlist is images only, and the
 *    stored content type comes from the allowlist rather than being echoed back
 *    from what the browser claimed.
 *  - **A filename that escapes.** `../../etc/passwd`, a leading slash, an NTFS
 *    alternate data stream. The stored key is generated, never derived from the
 *    submitted name; the original is kept only as a display label.
 *  - **A filename that is itself a payload.** The original name is stored as
 *    data and rendered as text, never used to build a path or a shell command.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_REQUEST = 6;

/**
 * Images only, keyed by the magic bytes we expect to find.
 *
 * SVG is deliberately absent. It is an image to a user and a script host to a
 * browser, and there is no safe way to serve one from an origin that also holds
 * a session cookie.
 */
export const ALLOWED_IMAGE_TYPES: ReadonlyMap<
  string,
  { extension: string; magic: readonly number[][] }
> = new Map([
  ["image/jpeg", { extension: "jpg", magic: [[0xff, 0xd8, 0xff]] }],
  [
    "image/png",
    {
      extension: "png",
      magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    },
  ],
  ["image/gif", { extension: "gif", magic: [[0x47, 0x49, 0x46, 0x38]] }],
  // WebP is RIFF....WEBP — the first four bytes are checked here, with the
  // WEBP tag verified separately at offset 8.
  ["image/webp", { extension: "webp", magic: [[0x52, 0x49, 0x46, 0x46]] }],
]);

export type UploadRejection =
  | "too_large"
  | "empty"
  | "unsupported_type"
  | "content_mismatch"
  | "too_many";

export const REJECTION_MESSAGES: Record<UploadRejection, string> = {
  too_large: `That image is over ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB. Photos straight from a phone are usually fine — try one taken at a lower resolution.`,
  empty: "That file appears to be empty.",
  unsupported_type:
    "Please attach a photo — JPEG, PNG, GIF, or WebP. Other file types aren't accepted.",
  content_mismatch:
    "That file doesn't look like the image type its name suggests, so it wasn't accepted.",
  too_many: `Please attach no more than ${MAX_ATTACHMENTS_PER_REQUEST} images to one request.`,
};

export interface ValidatedUpload {
  bytes: Uint8Array;
  /** From the allowlist, never from the browser's claim. */
  contentType: string;
  extension: string;
  /** Original name, kept for display only. Never used to build a path. */
  displayName: string;
  size: number;
}

/** True when `bytes` opens with any of the candidate signatures. */
function matchesMagic(
  bytes: Uint8Array,
  candidates: readonly number[][],
): boolean {
  return candidates.some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
  );
}

function isWebp(bytes: Uint8Array): boolean {
  // RIFF <4-byte size> WEBP
  return (
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/**
 * Strip a submitted filename down to something safe to display.
 *
 * Not used to build a path — the stored key is generated — but a name rendered
 * in the admin UI should not carry control characters or 300 characters of
 * padding either. The NUL case matters most: it truncates C-style strings, so a
 * name like `photo.png.exe` can display as one thing and be handled as
 * another by anything downstream that is not JavaScript.
 */
export function safeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "image";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 120) || "image";
}

/**
 * Validate one uploaded file.
 *
 * The content type is decided by inspecting the bytes, not by trusting
 * `file.type` — that header is whatever the client chose to send. A `.png`
 * containing HTML fails here.
 */
export async function validateImageUpload(
  file: File,
): Promise<
  { ok: true; upload: ValidatedUpload } | { ok: false; reason: UploadRejection }
> {
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too_large" };

  const claimed = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  const allowed = ALLOWED_IMAGE_TYPES.get(claimed);
  if (!allowed) return { ok: false, reason: "unsupported_type" };

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Re-check from the actual buffer: `File.size` is a claim too.
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const signatureOk =
    matchesMagic(bytes, allowed.magic) &&
    (claimed !== "image/webp" || isWebp(bytes));

  if (!signatureOk) return { ok: false, reason: "content_mismatch" };

  return {
    ok: true,
    upload: {
      bytes,
      contentType: claimed,
      extension: allowed.extension,
      displayName: safeDisplayName(file.name),
      size: bytes.byteLength,
    },
  };
}

export interface StoredObject {
  /** Opaque key. Generated, never derived from the submitted filename. */
  key: string;
  size: number;
  contentType: string;
}

export interface StorageDriver {
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<StoredObject>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
