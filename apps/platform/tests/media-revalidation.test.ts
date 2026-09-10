import { describe, expect, it } from "vitest";
import { serveBytes } from "@/lib/media/serve";

/**
 * Not re-sending an image the browser already has.
 *
 * Derivatives were served with `max-age=3600, must-revalidate` and no validator
 * at all. That combination is worse than no cache: the browser dutifully asks
 * again once an hour, there is nothing to compare the answer against, and the
 * whole image comes back. A client browsing their library across a working day
 * re-downloaded every thumbnail, in full, once an hour — the largest avoidable
 * use of bandwidth in the portal.
 *
 * An `ETag` turns that into a 304 with no body.
 */

const body = (size: number) => new Uint8Array(size).fill(0x42);

const common = {
  contentType: "image/webp",
  disposition: "inline",
  cacheControl: "private, max-age=3600, must-revalidate",
  rangeHeader: null,
};

describe("revalidating a cached image", () => {
  it("offers a validator, so a revalidation has something to compare", () => {
    const response = serveBytes({ ...common, bytes: body(2048), etag: "abc123" });

    expect(response.headers.get("ETag")).toBe('"abc123"');
  });

  it("answers 304 with no body when the browser already has it", async () => {
    const response = serveBytes({
      ...common,
      bytes: body(2048),
      etag: "abc123",
      ifNoneMatch: '"abc123"',
    });

    expect(response.status).toBe(304);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("sends the image when the validator does not match", async () => {
    const response = serveBytes({
      ...common,
      bytes: body(2048),
      etag: "abc123",
      ifNoneMatch: '"something-else"',
    });

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(2048);
  });

  it("handles the list of tags a real browser sends", () => {
    // Comparing the raw header against one tag would miss every browser that
    // sends more than one — a cache that looks enabled and never hits.
    const response = serveBytes({
      ...common,
      bytes: body(2048),
      etag: "abc123",
      ifNoneMatch: '"stale-one", W/"abc123", "another"',
    });

    expect(response.status).toBe(304);
  });

  it("treats a weak validator as matching, which is correct for a cache", () => {
    const response = serveBytes({
      ...common,
      bytes: body(2048),
      etag: "abc123",
      ifNoneMatch: 'W/"abc123"',
    });

    expect(response.status).toBe(304);
  });

  it("honours `*`", () => {
    const response = serveBytes({
      ...common,
      bytes: body(2048),
      etag: "abc123",
      ifNoneMatch: "*",
    });

    expect(response.status).toBe(304);
  });

  it("answers 304 even for a range request, as the specification requires", () => {
    // And this is where the saving is largest: a matching validator means no
    // body at all, whatever was asked for.
    const response = serveBytes({
      ...common,
      bytes: body(8192),
      rangeHeader: "bytes=0-1023",
      etag: "abc123",
      ifNoneMatch: '"abc123"',
    });

    expect(response.status).toBe(304);
  });

  it("behaves exactly as before when no validator is available", async () => {
    const response = serveBytes({ ...common, bytes: body(2048) });

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(2048);
  });

  it("does not 304 on a stale request when we have no validator to offer", () => {
    // A client that kept an ETag from an older deploy must not be told 304 by
    // a response that cannot vouch for the bytes.
    const response = serveBytes({
      ...common,
      bytes: body(2048),
      etag: null,
      ifNoneMatch: '"abc123"',
    });

    expect(response.status).toBe(200);
  });
});
