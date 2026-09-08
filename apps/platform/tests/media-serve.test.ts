import { describe, expect, it } from "vitest";
import {
  MAX_SERVEABLE_BYTES,
  parseRange,
  serveBytes,
} from "@/lib/media/serve";
import { MAX_ORIGINAL_BYTES } from "@/lib/media/constants";

/**
 * Serving bytes within the platform's response ceiling.
 *
 * A Netlify function may return at most 20 MB in one streamed response. The
 * cases below are the ones where getting this wrong is silent: a truncated body
 * returned with a 200, or a range honoured only partly, both produce a corrupt
 * file at the other end rather than an error anyone would notice.
 */

function body(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

describe("parseRange", () => {
  it("treats a missing header as a whole-object request", () => {
    expect(parseRange(null, 1000)).toEqual({ kind: "none" });
  });

  it("reads a closed range", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({
      kind: "ok",
      range: { start: 0, end: 499, length: 500 },
    });
  });

  it("reads an open-ended range", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({
      kind: "ok",
      range: { start: 500, end: 999, length: 500 },
    });
  });

  it("reads a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({
      kind: "ok",
      range: { start: 900, end: 999, length: 100 },
    });
  });

  it("clamps an end past the object rather than refusing", () => {
    // A caller asking for more than exists gets what exists, per the spec.
    expect(parseRange("bytes=900-5000", 1000)).toEqual({
      kind: "ok",
      range: { start: 900, end: 999, length: 100 },
    });
  });

  it("refuses a start past the end of the object", () => {
    expect(parseRange("bytes=1000-1100", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a reversed range", () => {
    expect(parseRange("bytes=500-100", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a range larger than one response may carry", () => {
    // Truncating it instead would return fewer bytes than the Content-Range
    // claimed, and the caller would write a corrupt file believing it succeeded.
    const size = MAX_SERVEABLE_BYTES * 2;
    expect(parseRange(`bytes=0-${size - 1}`, size)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a header it cannot parse", () => {
    expect(parseRange("bytes=abc", 1000)).toEqual({ kind: "none" });
    expect(parseRange("items=0-10", 1000)).toEqual({ kind: "none" });
    // Multi-range is deliberately unsupported; treated as absent rather than
    // answered with a body that claims to be multipart and is not.
    expect(parseRange("bytes=0-10,20-30", 1000)).toEqual({ kind: "none" });
  });
});

describe("serveBytes", () => {
  const common = {
    contentType: "image/jpeg",
    disposition: "attachment",
    cacheControl: "private, no-store",
  };

  it("returns the whole object when it fits", async () => {
    const bytes = body(2048);
    const response = serveBytes({ ...common, bytes, rangeHeader: null });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("2048");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("returns exactly the requested slice with a 206", async () => {
    const bytes = body(4096);
    const response = serveBytes({ ...common, bytes, rangeHeader: "bytes=100-199" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 100-199/4096");
    expect(response.headers.get("Content-Length")).toBe("100");

    const returned = new Uint8Array(await response.arrayBuffer());
    expect(returned.byteLength).toBe(100);
    // The right slice, not merely the right length.
    expect(returned).toEqual(bytes.subarray(100, 200));
  });

  it("reassembles byte-for-byte across sequential ranges", async () => {
    // This is what a caller fetching a large original in pieces actually does,
    // and the property that matters is that the pieces join back into the file.
    const bytes = body(10_000);
    const chunk = 3000;
    const parts: Uint8Array[] = [];

    for (let start = 0; start < bytes.byteLength; start += chunk) {
      const end = Math.min(start + chunk - 1, bytes.byteLength - 1);
      const response = serveBytes({
        ...common,
        bytes,
        rangeHeader: `bytes=${start}-${end}`,
      });
      expect(response.status).toBe(206);
      parts.push(new Uint8Array(await response.arrayBuffer()));
    }

    const joined = new Uint8Array(bytes.byteLength);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    expect(joined).toEqual(bytes);
  });

  it("answers 416 with a Content-Range for an unsatisfiable range", () => {
    const bytes = body(1000);
    const response = serveBytes({ ...common, bytes, rangeHeader: "bytes=5000-6000" });

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("refuses a whole-object request that exceeds the ceiling, and says how to succeed", async () => {
    const bytes = body(MAX_SERVEABLE_BYTES + 1);
    const response = serveBytes({ ...common, bytes, rangeHeader: null });

    // 413 rather than a truncated 200. A caller that received a short body with
    // a success status would write a broken image and not know.
    expect(response.status).toBe(413);
    const payload = (await response.json()) as {
      error: string;
      size: number;
      maxPerResponse: number;
      message: string;
    };
    expect(payload.error).toBe("too_large_for_one_response");
    expect(payload.size).toBe(MAX_SERVEABLE_BYTES + 1);
    expect(payload.maxPerResponse).toBe(MAX_SERVEABLE_BYTES);
    // The message has to be actionable — it is the only thing a runner sees.
    expect(payload.message).toMatch(/Range/);
  });

  it("advertises range support on every reply", () => {
    const bytes = body(100);
    for (const rangeHeader of [null, "bytes=0-9", "bytes=500-600"]) {
      const response = serveBytes({ ...common, bytes, rangeHeader });
      expect(response.headers.get("Accept-Ranges"), String(rangeHeader)).toBe("bytes");
    }
  });

  it("never sniffs, indexes or leaks a referrer", () => {
    const response = serveBytes({ ...common, bytes: body(10), rangeHeader: null });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("the upload limit and the serve limit agree", () => {
  it("never accepts an original larger than one response can return", () => {
    // The whole point of deriving one from the other. If these ever diverge,
    // the library would store files it could not hand back — and nothing would
    // notice until an agent run came up empty.
    expect(MAX_ORIGINAL_BYTES).toBeLessThanOrEqual(MAX_SERVEABLE_BYTES);
  });

  it("stays under Netlify's documented 20 MB streamed-response ceiling", () => {
    expect(MAX_SERVEABLE_BYTES).toBeLessThan(20 * 1024 * 1024);
  });
});
