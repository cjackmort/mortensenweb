/**
 * The limits and formats of the media library, in one place.
 *
 * These numbers are not arbitrary and several of them are dictated by the
 * platform rather than chosen. Where that is true it is said so, because a
 * future reader raising a limit needs to know which ones they *can* raise.
 */

// ---------------------------------------------------------------------------
// Upload sizing
// ---------------------------------------------------------------------------

/**
 * How much of one file goes in a single request.
 *
 * **This is a platform ceiling, not a preference.** Netlify runs functions on
 * AWS Lambda, which caps a synchronous request body at 6 MB; binary content is
 * base64-encoded on the way in, adding roughly a third, so the real ceiling for
 * bytes is about 4.5 MB. It cannot be raised on any plan.
 *
 * 3 MB leaves room for the multipart envelope, the form field names, and the
 * encoding overhead, with margin left over. Raising this to 4 MB would work
 * until a filename was long enough that it did not.
 */
export const UPLOAD_PART_BYTES = 3 * 1024 * 1024;

/**
 * The largest original we will store.
 *
 * Sized for what clients actually have: a 48-megapixel phone photo is 15-25 MB
 * and a scanned artwork can reach 40 MB. At `UPLOAD_PART_BYTES` this is at most
 * 17 parts, which retries comfortably on a phone connection.
 */
export const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;

/** How many files one browser session may have in flight. Keeps a phone sane. */
export const MAX_CONCURRENT_UPLOADS = 3;

/**
 * How long an unfinished upload session survives before the sweeper takes it.
 *
 * Long enough for a slow connection to finish a 50 MB file with retries, short
 * enough that a closed tab does not hold quota for a day.
 */
export const UPLOAD_SESSION_TTL_MINUTES = 120;

/** Default per-client storage allowance. Overridden by `clients.media_quota_bytes`. */
export const DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/**
 * What the library accepts, decided by magic bytes rather than by extension or
 * by what the browser claimed.
 *
 * SVG is absent for the same reason it is absent from request attachments: it
 * is an image to a person and a script host to a browser, and this origin
 * carries a session cookie.
 *
 * **HEIC and HEIF are deliberately absent, and that is a real limitation.**
 * Decoding them needs libheif, which the prebuilt `sharp` binaries do not
 * carry, so accepting one would mean storing a file we could never generate a
 * thumbnail or a web size from. They are detected specifically — see
 * `sniffImageFormat` — so an iPhone user gets told what happened and what to do
 * about it, rather than "unsupported file".
 */
export const SUPPORTED_FORMATS = ["jpeg", "png", "gif", "webp"] as const;

export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

export const FORMAT_CONTENT_TYPES: Record<SupportedFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export const FORMAT_EXTENSIONS: Record<SupportedFormat, string> = {
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
};

/** What the file picker offers. A convenience; the bytes are still inspected. */
export const UPLOAD_ACCEPT_ATTRIBUTE = "image/jpeg,image/png,image/gif,image/webp";

/** Said in the UI, so it stays in step with what the code actually accepts. */
export const SUPPORTED_FORMATS_LABEL = "JPEG, PNG, GIF and WebP";

// ---------------------------------------------------------------------------
// Derivatives
// ---------------------------------------------------------------------------

export type DerivativeKind = "thumb" | "preview" | "web_sm" | "web_md" | "web_lg";

export interface DerivativeSpec {
  kind: DerivativeKind;
  /** Longest edge in pixels. Never upscaled past the original — see the job. */
  maxEdge: number;
  /** What this size is for, shown to the client beside it. */
  purpose: string;
}

/**
 * The sizes generated from every original.
 *
 * `thumb` and `preview` exist for the library itself. The `web_*` sizes are
 * what a built site would reference in a `srcset`, and they stop at 2048
 * because a wider one is bytes no viewport spends.
 *
 * Every one of these is written to its own key. None of them ever replaces the
 * original — that is the whole contract of this library.
 */
export const DERIVATIVE_SPECS: readonly DerivativeSpec[] = [
  { kind: "thumb", maxEdge: 400, purpose: "Library grid" },
  { kind: "preview", maxEdge: 1200, purpose: "Library preview" },
  { kind: "web_sm", maxEdge: 640, purpose: "Phones" },
  { kind: "web_md", maxEdge: 1280, purpose: "Tablets and small laptops" },
  { kind: "web_lg", maxEdge: 2048, purpose: "Large screens" },
];

/**
 * Below this, a resolution warning is worth raising for a full-width use.
 *
 * A warning, never a refusal and never an upscale. Enlarging pixels that were
 * never captured produces a blurry image that looks like a mistake we made,
 * so the client is told the number and left to decide.
 */
export const FULL_WIDTH_MIN_EDGE = 1600;

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const MAX_FOLDER_DEPTH = 10;
export const MAX_FOLDER_NAME_LENGTH = 80;
export const MAX_ASSET_TITLE_LENGTH = 120;
export const MAX_ASSET_DESCRIPTION_LENGTH = 600;

/**
 * How many assets one request may carry.
 *
 * Higher than the six the old form allowed, because the reason for six was the
 * body limit and these no longer travel in the request body — only their
 * identifiers do. Still bounded, because an agent given ninety photos and one
 * sentence has not been given a brief.
 */
export const MAX_ASSETS_PER_REQUEST = 24;
