import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentUrl,
  signAttachmentToken,
  verifyAttachmentToken,
} from "@/lib/storage/signed-links";

/**
 * Signed attachment links.
 *
 * These tokens are the only authorisation on an unauthenticated route that
 * serves client-uploaded images, so the tests here are about the ways a token
 * could be accepted when it should not be:
 *
 *  - forged outright, or signed with a different secret
 *  - a real token with its expiry edited to a later one
 *  - a real token pointed at a different attachment
 *  - a token that has simply run out
 *
 * The happy path is checked too, but it is not what these are for.
 */

const SECRET = "test-signing-secret";
const OTHER_SECRET = "someone-elses-secret";

let savedSecret: string | undefined;
let savedUrl: string | undefined;

beforeEach(() => {
  savedSecret = process.env.AUTH_SECRET;
  savedUrl = process.env.AUTH_URL;
  process.env.AUTH_SECRET = SECRET;
  process.env.AUTH_URL = "https://portal.example.com";
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
  if (savedUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = savedUrl;
});

const encode = (value: string) =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("signing and verifying", () => {
  it("round-trips a token back to its attachment", async () => {
    const token = await signAttachmentToken("ATTACH123");
    expect(token).not.toBeNull();

    const check = await verifyAttachmentToken(token!);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.attachmentPublicId).toBe("ATTACH123");
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await signAttachmentToken("ATTACH123");

    process.env.AUTH_SECRET = OTHER_SECRET;
    const check = await verifyAttachmentToken(token!);

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("bad_signature");
  });

  it("refuses an expiry extended after signing", async () => {
    // The attack this exists to stop: take a real token, push the expiry out,
    // keep access forever. It fails because the expiry is inside the signed
    // payload rather than a parameter sitting next to it.
    const token = await signAttachmentToken("ATTACH123");
    const [payloadPart, signaturePart] = token!.split(".");

    const original = atob(
      payloadPart!.replace(/-/g, "+").replace(/_/g, "/"),
    );
    const tampered = `${original.split(".")[0]}.${Date.now() + 999_999_999}`;

    const check = await verifyAttachmentToken(
      `${encode(tampered)}.${signaturePart}`,
    );

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("bad_signature");
  });

  it("refuses a token repointed at another attachment", async () => {
    const token = await signAttachmentToken("ATTACH123");
    const [payloadPart, signaturePart] = token!.split(".");

    const original = atob(payloadPart!.replace(/-/g, "+").replace(/_/g, "/"));
    const swapped = `SOMEONEELSES.${original.split(".")[1]}`;

    const check = await verifyAttachmentToken(
      `${encode(swapped)}.${signaturePart}`,
    );

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("bad_signature");
  });

  it("refuses a token that has run out", async () => {
    const token = await signAttachmentToken("ATTACH123", { ttlMinutes: -1 });
    const check = await verifyAttachmentToken(token!);

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("expired");
  });

  it("reports a bad signature before it reports expiry", async () => {
    // Answering "expired" for a payload we never signed would confirm to an
    // attacker that their forgery parsed. Small oracle, free to avoid.
    const forged = `${encode(`ATTACH123.${Date.now() - 1000}`)}.${encode("nonsense")}`;
    const check = await verifyAttachmentToken(forged);

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("bad_signature");
  });

  it("refuses malformed input rather than throwing", async () => {
    for (const bad of ["", "nodot", "a.b.c.d", "!!!.???"]) {
      const check = await verifyAttachmentToken(bad);
      expect(check.ok).toBe(false);
    }
  });
});

describe("when signing is unavailable", () => {
  it("produces no token rather than an unsigned one", async () => {
    delete process.env.AUTH_SECRET;

    // Null, never a bare id. A caller must end up with no attachment links
    // instead of links that anyone could construct.
    expect(await signAttachmentToken("ATTACH123")).toBeNull();
    expect(await attachmentUrl("ATTACH123")).toBeNull();
  });

  it("refuses every token", async () => {
    const token = await signAttachmentToken("ATTACH123");
    delete process.env.AUTH_SECRET;

    const check = await verifyAttachmentToken(token!);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("not_configured");
  });

  it("produces no URL without a configured origin", async () => {
    delete process.env.AUTH_URL;
    expect(await attachmentUrl("ATTACH123")).toBeNull();
  });
});

describe("the URL handed to the agent", () => {
  it("points at the serving route and carries the token in the path", async () => {
    const url = await attachmentUrl("ATTACH123");

    expect(url).toMatch(
      /^https:\/\/portal\.example\.com\/api\/attachments\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    // Not a query string: those end up in referrer headers and access logs
    // more readily than path segments do.
    expect(url).not.toContain("?");
  });

  it("survives a trailing slash on the configured origin", async () => {
    process.env.AUTH_URL = "https://portal.example.com/";
    const url = await attachmentUrl("ATTACH123");
    expect(url).not.toContain("//api/");
  });
});
