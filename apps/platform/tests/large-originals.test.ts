import { describe, expect, it } from "vitest";
import { MAX_ORIGINAL_BYTES, MAX_SERVEABLE_BYTES } from "@/lib/media/constants";
import { serveBytes } from "@/lib/media/serve";

/**
 * Originals larger than one response can carry.
 *
 * The upload ceiling used to be defined as `MAX_SERVEABLE_BYTES` exactly, so a
 * file we could not hand back in a single response could not be stored either.
 * A client hit that with a 16.9 MB photograph of a painting, which is squarely
 * the case the library exists for.
 *
 * The two are now separate, and these tests are the reason that is safe: a
 * whole-object read of something too big is refused loudly, with the size, the
 * per-response limit, and the literal `Range` header to retry with. Silence, a
 * truncated body, or a gateway error would each have made the old coupling the
 * right call.
 */

const png = (size: number) => new Uint8Array(size).fill(0x89);

const common = {
  contentType: "image/png",
  disposition: "attachment",
  cacheControl: "private, no-store",
};

describe("an original bigger than one response", () => {
  it("may be stored, even though it cannot be sent in one piece", () => {
    // The point of the change. If these are ever equal again, a client with a
    // large scan is turned away at the upload form.
    expect(MAX_ORIGINAL_BYTES).toBeGreaterThan(MAX_SERVEABLE_BYTES);
  });

  it("comfortably clears the file that prompted this", () => {
    const theirPhotograph = 16.9 * 1024 * 1024;
    expect(MAX_ORIGINAL_BYTES).toBeGreaterThan(theirPhotograph);
  });

  it("refuses a whole-object read rather than truncating it", async () => {
    const response = serveBytes({
      ...common,
      bytes: png(MAX_SERVEABLE_BYTES + 1),
      rangeHeader: null,
    });

    // A truncated body would look like a corrupt image much later; a gateway
    // error would look like our bug rather than a request that needs changing.
    expect(response.status).toBe(413);
  });

  it("says how to succeed on the next attempt", async () => {
    const size = MAX_SERVEABLE_BYTES + 1;
    const response = serveBytes({ ...common, bytes: png(size), rangeHeader: null });
    const body = (await response.json()) as {
      size: number;
      maxPerResponse: number;
      message: string;
    };

    expect(body.size).toBe(size);
    expect(body.maxPerResponse).toBe(MAX_SERVEABLE_BYTES);
    // The literal header, not a description of one. The agent reads this.
    expect(body.message).toContain(`bytes=0-${MAX_SERVEABLE_BYTES - 1}`);
  });

  it("serves that same object in pieces when asked properly", async () => {
    const size = MAX_SERVEABLE_BYTES + 1024;
    const bytes = png(size);

    const first = serveBytes({
      ...common,
      bytes,
      rangeHeader: `bytes=0-${MAX_SERVEABLE_BYTES - 1}`,
    });
    const second = serveBytes({
      ...common,
      bytes,
      rangeHeader: `bytes=${MAX_SERVEABLE_BYTES}-${size - 1}`,
    });

    expect(first.status).toBe(206);
    expect(second.status).toBe(206);

    // Reassembled, the pieces are the file — which is what makes refusing the
    // whole-object read a redirection rather than a dead end.
    const rejoined =
      (await first.arrayBuffer()).byteLength +
      (await second.arrayBuffer()).byteLength;
    expect(rejoined).toBe(size);
  });

  it("keeps the part count far below the session limit", () => {
    // `media_uploads_part_count_bounded` caps a session at 2000 parts.
    const PART_BYTES = 3 * 1024 * 1024;
    expect(Math.ceil(MAX_ORIGINAL_BYTES / PART_BYTES)).toBeLessThan(100);
  });
});
