/**
 * Serving stored bytes over HTTP, within the platform's response ceiling.
 *
 * ## The ceiling this exists for
 *
 * A Netlify function may return at most **20 MB** in a streamed response (6 MB
 * unstreamed), and it runs on a 60-second clock. Netlify Blobs will happily
 * store a 5 GB object, and the upload path will happily assemble one — so
 * without something here, the library would accept originals it could never
 * hand back. That failure would not appear until an agent run or a client's
 * download quietly returned nothing useful.
 *
 * Two things follow.
 *
 * **Range requests are supported.** A caller that asks for bytes 0-8388607 gets
 * exactly those, with a 206 and a `Content-Range`. That makes a large original
 * retrievable in pieces by anything that speaks HTTP properly, and it makes a
 * client's download resumable on a bad connection rather than starting again.
 *
 * **A whole-object request that would exceed the ceiling is refused, loudly.**
 * 413 with a message naming the size and the limit, rather than a truncated
 * body or a gateway error that looks like a bug in the caller. `MAX_SERVEABLE_
 * BYTES` is what the upload limit is derived from, so the two cannot drift.
 */

/**
 * Most that may go out in one response.
 *
 * Netlify's documented ceiling for a streamed synchronous function is 20 MB.
 * This sits below it to leave room for headers and for any encoding the
 * platform applies on the way out — the request side base64-encodes binary and
 * loses about a third, and the response side has not been measured here, so the
 * margin is deliberately generous until it has been.
 */
export const MAX_SERVEABLE_BYTES = 16 * 1024 * 1024;

export interface RangeRequest {
  start: number;
  end: number;
  length: number;
}

export type RangeParse =
  | { kind: "none" }
  | { kind: "ok"; range: RangeRequest }
  | { kind: "unsatisfiable" };

/**
 * Parse a single-range `Range: bytes=…` header.
 *
 * Multi-range requests are deliberately not supported: they require a
 * multipart/byteranges response, no caller here sends one, and a half-correct
 * implementation of that is worse than an honest refusal. An unparseable header
 * is treated as absent, which is what the specification asks for.
 */
export function parseRange(header: string | null, size: number): RangeParse {
  if (!header) return { kind: "none" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "none" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // `bytes=-500` means the *last* 500 bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: "unsatisfiable" };
  }

  if (start < 0 || start >= size || end < start) return { kind: "unsatisfiable" };
  end = Math.min(end, size - 1);

  const length = end - start + 1;
  // A range larger than we can return in one response is refused rather than
  // silently truncated — a caller that received fewer bytes than it asked for,
  // with a 206 saying otherwise, would write a corrupt file.
  if (length > MAX_SERVEABLE_BYTES) return { kind: "unsatisfiable" };

  return { kind: "ok", range: { start, end, length } };
}

export interface ServeOptions {
  bytes: Uint8Array;
  contentType: string;
  /** `attachment` for downloads, `inline` for images the library displays. */
  disposition: string;
  cacheControl: string;
  /**
   * A validator for this exact body, if the caller can name one.
   *
   * Without it `must-revalidate` is a full re-download every time the cache
   * expires: the browser asks again, there is nothing to compare, and the whole
   * image comes back. A library of thumbnails re-sent once an hour is the
   * single largest avoidable use of bandwidth in the portal.
   *
   * Quoted here rather than at every call site, so a caller passes an identity
   * and not a header.
   */
  etag?: string | null;
  /** The request's `If-None-Match`, so an unchanged body answers 304. */
  ifNoneMatch?: string | null;
  rangeHeader: string | null;
}

/**
 * Build the response, honouring a range when one was asked for.
 *
 * `Accept-Ranges: bytes` is advertised on every reply so a caller that hits the
 * 413 knows what to do about it, rather than only discovering ranges are
 * available by guessing.
 */
/**
 * Does the request's `If-None-Match` cover this entity?
 *
 * The header is a comma-separated list, may be `*`, and may carry weak
 * validators prefixed `W/`. Comparing the raw header against one tag would
 * silently miss every browser that sends more than one, which is a cache that
 * looks enabled and never hits.
 */
function matchesEtag(ifNoneMatch: string, etag: string): boolean {
  const candidates = ifNoneMatch.split(",").map((value) => value.trim());
  if (candidates.includes("*")) return true;

  // Weak comparison is the correct one for cache revalidation: `W/"x"` and
  // `"x"` identify the same bytes for this purpose.
  const normalise = (value: string) => value.replace(/^W\//, "");
  return candidates.some((value) => normalise(value) === normalise(etag));
}

export function serveBytes(options: ServeOptions): Response {
  const size = options.bytes.byteLength;

  const etag = options.etag ? `"${options.etag}"` : null;

  const baseHeaders: Record<string, string> = {
    "Content-Type": options.contentType,
    "Content-Disposition": options.disposition,
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    ...(etag ? { ETag: etag } : {}),
  };

  // Answered before the range is even parsed, which is what the specification
  // asks for and also what makes this worth having: a matching validator means
  // no body at all, whatever was requested.
  if (etag && options.ifNoneMatch && matchesEtag(options.ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const parsed = parseRange(options.rangeHeader, size);

  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (parsed.kind === "ok") {
    const { start, end, length } = parsed.range;
    const slice = options.bytes.subarray(start, end + 1);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  if (size > MAX_SERVEABLE_BYTES) {
    // Everything the caller needs to succeed on the next attempt: how big the
    // object is, what one response can carry, and that ranges are accepted.
    return new Response(
      JSON.stringify({
        error: "too_large_for_one_response",
        size,
        maxPerResponse: MAX_SERVEABLE_BYTES,
        message:
          `This file is ${size} bytes and a single response may carry at most ` +
          `${MAX_SERVEABLE_BYTES}. Request it in pieces with a Range header, ` +
          `for example "bytes=0-${MAX_SERVEABLE_BYTES - 1}".`,
      }),
      {
        status: 413,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
          "Content-Disposition": "inline",
        },
      },
    );
  }

  return new Response(options.bytes as unknown as BodyInit, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
