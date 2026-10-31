import { describe, expect, it } from "vitest";
import {
  FRAME_FIX,
  checkSiteFraming,
  framingBlockMessage,
  framingVerdict,
  liveThumbnailGate,
} from "@/lib/frame-check";

/**
 * Whether the portal may put a client's home page in an iframe.
 *
 * Two headers can refuse it, and they are not equals: `Content-Security-Policy:
 * frame-ancestors` can name the portal, `X-Frame-Options` cannot (only DENY and
 * SAMEORIGIN exist), and where both are sent a browser obeys the CSP and
 * ignores the other. Getting that precedence wrong either blocks a site that
 * works or approves one that renders an empty tile.
 */

function headers(values: Record<string, string>) {
  return new Headers(values);
}

describe("framingVerdict", () => {
  it("allows a site that sends neither header", () => {
    expect(framingVerdict(headers({}))).toEqual({ framable: true });
  });

  it("blocks X-Frame-Options: SAMEORIGIN, because the portal is another origin", () => {
    const verdict = framingVerdict(headers({ "x-frame-options": "SAMEORIGIN" }));

    expect(verdict).toMatchObject({
      framable: false,
      blockedBy: "x-frame-options",
      header: "X-Frame-Options: SAMEORIGIN",
    });
  });

  it("blocks X-Frame-Options: DENY in any case", () => {
    const verdict = framingVerdict(headers({ "X-Frame-Options": "deny" }));

    expect(verdict).toMatchObject({ framable: false, blockedBy: "x-frame-options" });
  });

  it("ignores the obsolete ALLOW-FROM form, which no current browser honours", () => {
    const verdict = framingVerdict(
      headers({ "x-frame-options": "ALLOW-FROM https://portal.mortensenweb.com" }),
    );

    expect(verdict).toEqual({ framable: true });
  });

  it("blocks frame-ancestors 'none'", () => {
    const verdict = framingVerdict(
      headers({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }),
    );

    expect(verdict).toMatchObject({
      framable: false,
      blockedBy: "csp-frame-ancestors",
      header: "Content-Security-Policy: frame-ancestors 'none'",
    });
  });

  it("blocks frame-ancestors 'self', which names the site but not the portal", () => {
    const verdict = framingVerdict(
      headers({ "content-security-policy": "frame-ancestors 'self'" }),
    );

    expect(verdict).toMatchObject({ framable: false, blockedBy: "csp-frame-ancestors" });
  });

  it("treats an empty frame-ancestors list as 'none'", () => {
    const verdict = framingVerdict(headers({ "content-security-policy": "frame-ancestors" }));

    expect(verdict).toMatchObject({ framable: false, blockedBy: "csp-frame-ancestors" });
  });

  it("allows the exact line the portal asks sites to send", () => {
    const verdict = framingVerdict(headers({ "content-security-policy": FRAME_FIX.split(": ")[1]! }));

    expect(verdict).toEqual({ framable: true });
  });

  it.each([
    ["a scheme-less host", "frame-ancestors portal.mortensenweb.com"],
    ["an http scheme source, which matches https", "frame-ancestors http://portal.mortensenweb.com"],
    ["a wildcard subdomain", "frame-ancestors https://*.mortensenweb.com"],
    ["the https: scheme", "frame-ancestors https:"],
    ["a bare wildcard", "frame-ancestors *"],
    ["an explicit default port", "frame-ancestors https://portal.mortensenweb.com:443"],
    ["a wildcard port", "frame-ancestors https://portal.mortensenweb.com:*"],
    ["the portal among other sources", "frame-ancestors 'self' https://example.com https://portal.mortensenweb.com"],
    ["an upper-case directive name", "Frame-Ancestors https://portal.mortensenweb.com"],
  ])("allows %s", (_label, policy) => {
    expect(framingVerdict(headers({ "content-security-policy": policy }))).toEqual({
      framable: true,
    });
  });

  it.each([
    ["a different host", "frame-ancestors https://example.com"],
    ["a sibling subdomain", "frame-ancestors https://app.mortensenweb.com"],
    ["the bare parent of a wildcard", "frame-ancestors https://*.portal.mortensenweb.com"],
    ["a host that merely ends the same way", "frame-ancestors https://evilportal.mortensenweb.com"],
    ["a non-default port", "frame-ancestors https://portal.mortensenweb.com:8443"],
    ["the wrong scheme", "frame-ancestors ftp://portal.mortensenweb.com"],
  ])("blocks %s", (_label, policy) => {
    expect(framingVerdict(headers({ "content-security-policy": policy }))).toMatchObject({
      framable: false,
      blockedBy: "csp-frame-ancestors",
    });
  });

  it("lets a CSP that names the portal override X-Frame-Options, as browsers do", () => {
    const verdict = framingVerdict(
      headers({
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "frame-ancestors 'self' https://portal.mortensenweb.com",
      }),
    );

    expect(verdict).toEqual({ framable: true });
  });

  it("does not let X-Frame-Options approve a site whose CSP refuses the portal", () => {
    const verdict = framingVerdict(
      headers({
        "x-frame-options": "ALLOW-FROM https://portal.mortensenweb.com",
        "content-security-policy": "frame-ancestors 'none'",
      }),
    );

    expect(verdict).toMatchObject({ framable: false, blockedBy: "csp-frame-ancestors" });
  });

  it("falls back to X-Frame-Options when the CSP has no frame-ancestors", () => {
    const verdict = framingVerdict(
      headers({
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; img-src *",
      }),
    );

    expect(verdict).toMatchObject({ framable: false, blockedBy: "x-frame-options" });
  });

  it("requires every enforced policy to allow the portal", () => {
    // Two CSP headers arrive as one comma-joined value; each is enforced on
    // its own, so the stricter one wins.
    const verdict = framingVerdict(
      headers({
        "content-security-policy":
          "frame-ancestors https://portal.mortensenweb.com, frame-ancestors 'none'",
      }),
    );

    expect(verdict).toMatchObject({ framable: false, blockedBy: "csp-frame-ancestors" });
  });

  it("ignores a report-only policy, which never blocks a frame", () => {
    const verdict = framingVerdict(
      headers({ "content-security-policy-report-only": "frame-ancestors 'none'" }),
    );

    expect(verdict).toEqual({ framable: true });
  });
});

describe("framingBlockMessage", () => {
  it("names X-Frame-Options and the one-line fix", () => {
    const message = framingBlockMessage(
      { framable: false, blockedBy: "x-frame-options", header: "X-Frame-Options: SAMEORIGIN" },
      "https://scottmortensen.example",
    );

    expect(message.message).toContain("X-Frame-Options: SAMEORIGIN");
    expect(message.message).toContain("scottmortensen.example");
    expect(message.fix).toBe(
      "Content-Security-Policy: frame-ancestors 'self' https://portal.mortensenweb.com",
    );
  });

  it("names the frame-ancestors the site sent when it leaves the portal out", () => {
    const message = framingBlockMessage(
      {
        framable: false,
        blockedBy: "csp-frame-ancestors",
        header: "Content-Security-Policy: frame-ancestors 'self'",
      },
      "https://example.test",
    );

    expect(message.message).toContain("frame-ancestors 'self'");
    expect(message.message).toContain("portal");
    expect(message.fix).toBe(FRAME_FIX);
  });
});

describe("checkSiteFraming", () => {
  function respond(init: ResponseInit & { body?: string }, url = "https://example.test/") {
    const response = new Response(init.body ?? "<html></html>", init);
    Object.defineProperty(response, "url", { value: url });
    return async () => response;
  }

  it("reads the headers of the page the frame would load", async () => {
    const result = await checkSiteFraming("https://example.test", {
      fetchImpl: respond({ status: 200, headers: { "x-frame-options": "SAMEORIGIN" } }),
    });

    expect(result).toMatchObject({ framable: false, blockedBy: "x-frame-options" });
  });

  it("allows a site that names the portal", async () => {
    const result = await checkSiteFraming("https://example.test", {
      fetchImpl: respond({
        status: 200,
        headers: { "content-security-policy": "frame-ancestors 'self' https://portal.mortensenweb.com" },
      }),
    });

    expect(result).toEqual({ framable: true });
  });

  it("says the site could not be checked, rather than guessing, when it is unreachable", async () => {
    const result = await checkSiteFraming("https://example.test", {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(result).toEqual({
      framable: null,
      reason: "Could not reach https://example.test (fetch failed).",
    });
  });

  it("says the site could not be checked when it answers with a server error", async () => {
    const result = await checkSiteFraming("https://example.test", {
      fetchImpl: respond({ status: 503 }),
    });

    expect(result).toMatchObject({ framable: null });
    expect((result as { reason: string }).reason).toContain("503");
  });

  it("refuses to fetch anything that is not http or https", async () => {
    let called = false;
    const result = await checkSiteFraming("file:///etc/passwd", {
      fetchImpl: async () => {
        called = true;
        return new Response("");
      },
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({ framable: null });
  });
});

describe("liveThumbnailGate", () => {
  function sends(headers: Record<string, string>, status = 200) {
    return {
      fetchImpl: async () => new Response("<html></html>", { status, headers }),
    };
  }

  it("lets a site that names the portal go live", async () => {
    const gate = await liveThumbnailGate(
      "https://allowed.example",
      sends({ "content-security-policy": "frame-ancestors 'self' https://portal.mortensenweb.com" }),
    );

    expect(gate).toEqual({ ok: true });
  });

  it("refuses a site that blocks framing, naming the header and giving the fix", async () => {
    const gate = await liveThumbnailGate(
      "https://scott.example",
      sends({ "x-frame-options": "SAMEORIGIN" }),
    );

    expect(gate).toEqual({
      ok: false,
      message: expect.stringContaining("X-Frame-Options: SAMEORIGIN"),
      fix: "Content-Security-Policy: frame-ancestors 'self' https://portal.mortensenweb.com",
    });
  });

  it("refuses when the site cannot be read, without offering a fix that may not apply", async () => {
    const gate = await liveThumbnailGate("https://down.example", {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(gate).toEqual({
      ok: false,
      message: expect.stringContaining("Could not reach https://down.example"),
    });
  });

  it("refuses a site with no address, because there is nothing to frame", async () => {
    const gate = await liveThumbnailGate(null);

    expect(gate).toEqual({
      ok: false,
      message: expect.stringContaining("no domain"),
    });
  });
});
