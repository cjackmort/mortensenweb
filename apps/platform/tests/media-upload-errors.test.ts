import { describe, expect, it } from "vitest";
import { fallbackFor, readError } from "@/lib/media/upload-client";

/**
 * What an upload says when it fails.
 *
 * Written after a production incident in which every upload failed and the
 * portal told the client "The connection dropped part-way." Nothing had
 * dropped: the server was throwing, Next rendered its HTML error page, the
 * uploader could not parse that as JSON, and its one fallback asserted a
 * specific cause it had no evidence for. That message sent the operator looking
 * at their own network while the real failure sat in the function log.
 *
 * A wrong explanation is worse than none. "Your connection dropped" and "we
 * broke" point at different people, and only one of them is ever true of a 5xx.
 */

const htmlErrorPage = (status = 500) =>
  new Response("<!DOCTYPE html><html><body>Internal Server Error</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });

describe("what the uploader tells a client when a part fails", () => {
  it("does not blame the connection for a server error", async () => {
    const message = await readError(htmlErrorPage(500), fallbackFor(500));

    expect(message).not.toMatch(/connection/i);
    expect(message).toMatch(/our side/i);
  });

  it("blames the connection only where that is a plausible cause", () => {
    // Below 500 the request reached us and was answered; a dropped or slow
    // connection is a real explanation for those.
    expect(fallbackFor(408)).toMatch(/connection dropped/i);
    expect(fallbackFor(409)).toMatch(/connection dropped/i);

    // At and above 500 it never is.
    for (const status of [500, 502, 503, 504]) {
      expect(fallbackFor(status)).not.toMatch(/connection/i);
    }
  });

  it("prefers the server's own message over any fallback", async () => {
    const answered = Response.json(
      { ok: false, message: "That part was larger than expected." },
      { status: 413 },
    );

    expect(await readError(answered, fallbackFor(413))).toBe(
      "That part was larger than expected.",
    );
  });

  it("falls back rather than throwing when the body is not JSON at all", async () => {
    // The exact shape of the incident: Next's HTML error page.
    const message = await readError(htmlErrorPage(500), fallbackFor(500));

    expect(message).toBeTruthy();
    expect(message).toMatch(/try again/i);
  });

  it("keeps the retry advice, because a 5xx here is worth retrying", () => {
    expect(fallbackFor(500)).toMatch(/try again/i);
  });

  it("never puts an exception in front of a client", async () => {
    // The stack goes to the function log. What comes back names the step that
    // failed and stops there.
    const fromRoute = Response.json(
      {
        ok: false,
        message:
          "We could not save that part. This is a problem on our side, not " +
          "your connection — please try again, and tell us if it keeps happening.",
      },
      { status: 500 },
    );

    const message = await readError(fromRoute, fallbackFor(500));

    for (const internal of ["Error:", "at Object.", "node_modules", "ECONN", "stack"]) {
      expect(message).not.toContain(internal);
    }
  });
});
