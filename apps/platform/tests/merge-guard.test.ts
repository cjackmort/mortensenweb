import { describe, expect, it } from "vitest";
import {
  clientFacingRefusal,
  isPathAllowed,
  isProtectedPath,
} from "@/lib/github/merge-guard";
import { previewUrlFor, toSiteName } from "@/lib/netlify/api";
import { referenceFromNote } from "@/lib/payments/square";
import {
  apexDomain,
  buildDnsRecords,
  renderRecordsText,
} from "@/lib/dns/records";

/**
 * The pure decisions.
 *
 * `evaluateMerge` itself talks to GitHub and is covered by its own integration
 * path; what is tested here is the logic it delegates to, which is where the
 * subtle mistakes live — a prefix match that also matches a longer name, a
 * protected-path check defeated by a leading `./`, a site name that silently
 * collides.
 */

describe("path scoping", () => {
  it("allows anything when no scope was set", () => {
    expect(isPathAllowed("src/index.html", [])).toBe(true);
  });

  it("allows an exact file and anything beneath a directory", () => {
    expect(isPathAllowed("src/pages/about.md", ["src/pages"])).toBe(true);
    expect(isPathAllowed("src/pages", ["src/pages"])).toBe(true);
  });

  it("does not let a directory prefix match a longer sibling name", () => {
    // The trailing-slash check is the whole reason this passes. Without it,
    // scoping a request to `src/app` would also permit `src/apple`.
    expect(isPathAllowed("src/apple/secret.ts", ["src/app"])).toBe(false);
  });

  it("refuses anything outside the scope", () => {
    expect(isPathAllowed("src/lib/auth.ts", ["src/pages"])).toBe(false);
  });

  it("refuses traversal outright rather than resolving it", () => {
    // GitHub does not return traversal sequences in `filename`, so one showing
    // up means something is wrong in a way that should stop the merge.
    expect(isPathAllowed("src/pages/../../etc/passwd", ["src/pages"])).toBe(false);
  });

  it("normalises a leading ./ on both sides", () => {
    expect(isPathAllowed("./src/pages/a.md", ["./src/pages"])).toBe(true);
  });
});

describe("protected paths", () => {
  it("protects the automation's own configuration", () => {
    expect(isProtectedPath(".github/workflows/claude.yml")).toBe(true);
    expect(isProtectedPath("netlify.toml")).toBe(true);
    expect(isProtectedPath("package.json")).toBe(true);
    expect(isProtectedPath("package-lock.json")).toBe(true);
  });

  it("is not defeated by a leading ./ or by casing", () => {
    expect(isProtectedPath("./.github/workflows/deploy.yml")).toBe(true);
    expect(isProtectedPath(".GitHub/workflows/deploy.yml")).toBe(true);
  });

  it("leaves ordinary site content alone", () => {
    expect(isProtectedPath("src/pages/index.astro")).toBe(false);
    expect(isProtectedPath("public/images/truck.jpg")).toBe(false);
  });
});

describe("client-facing refusals", () => {
  it("describes a pending check as a delay, not a failure", () => {
    expect(clientFacingRefusal("checks_pending")).toMatch(/shortly/i);
  });

  it("never tells a client about our security model", () => {
    // "Opened by an untrusted account" describes us, not their website, and a
    // client can do nothing with it except worry.
    const message = clientFacingRefusal("untrusted_author");
    expect(message).not.toMatch(/author|account|untrusted|allowlist/i);
    expect(message).toMatch(/review/i);
  });

  it("says plainly when a change was already applied", () => {
    expect(clientFacingRefusal("already_merged")).toMatch(/already live/i);
  });
});

describe("Netlify naming", () => {
  it("produces a DNS-safe label", () => {
    const name = toSiteName("Rocky Mountain Heating & Air, LLC", "abc123");
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name).not.toMatch(/^-|-$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("makes two identically-named businesses distinct", () => {
    // Names live in one global namespace. Without the suffix the second client
    // fails at scaffold time, in front of a prospect.
    const a = toSiteName("Rocky Mountain Heating", "aaa111");
    const b = toSiteName("Rocky Mountain Heating", "bbb222");
    expect(a).not.toBe(b);
  });

  it("strips accents rather than dropping the letters they sit on", () => {
    expect(toSiteName("Peña Landscaping", "abc123")).toContain("pena");
  });

  it("survives a name with nothing usable in it", () => {
    const name = toSiteName("!!!", "abc123");
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.length).toBeGreaterThan(1);
  });

  it("builds the alias URL the deploy workflow publishes to", () => {
    // This format is load-bearing: the workflow deploys with --alias pr-<n>,
    // and the portal predicts then verifies this exact URL.
    expect(previewUrlFor("acme-abc123", 42)).toBe(
      "https://pr-42--acme-abc123.netlify.app",
    );
  });
});

describe("Square reconciliation", () => {
  it("finds a reference code inside a longer note", () => {
    expect(referenceFromNote("MW-7F3K — website services")).toBe("MW-7F3K");
    expect(referenceFromNote("payment for MW-7F3K thanks")).toBe("MW-7F3K");
  });

  it("uppercases a lowercased code", () => {
    expect(referenceFromNote("mw-7f3k")).toBe("MW-7F3K");
  });

  it("returns null rather than guessing at an unlabelled payment", () => {
    // Guessing which invoice an unlabelled payment settles is how a client gets
    // marked paid for someone else's money.
    expect(referenceFromNote("thanks!")).toBeNull();
    expect(referenceFromNote(undefined)).toBeNull();
    // I, L, O and U are not in the alphabet, so this is not a real code.
    expect(referenceFromNote("MW-ILOU")).toBeNull();
  });
});

describe("DNS instructions", () => {
  it("reduces any form of a domain to its apex", () => {
    expect(apexDomain("https://www.example.com/contact")).toBe("example.com");
    expect(apexDomain("WWW.Example.COM")).toBe("example.com");
    expect(apexDomain("example.com")).toBe("example.com");
  });

  it("rejects something that is not a domain", () => {
    expect(apexDomain("localhost")).toBeNull();
    expect(apexDomain("two words.com")).toBeNull();
    expect(apexDomain("")).toBeNull();
  });

  it("builds an apex A record and a www CNAME, and nothing else", () => {
    const records = buildDnsRecords("example.com", "acme-abc123");

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: "A", host: "@" });
    expect(records[1]).toMatchObject({
      type: "CNAME",
      host: "www",
      value: "acme-abc123.netlify.app",
    });

    // Nothing touching mail. Telling a small business to move nameservers can
    // take their email down for a day, and they will not connect the two.
    expect(records.some((r) => r.type.toString().includes("MX"))).toBe(false);
  });

  it("renders an aligned table for copying into a registrar form", () => {
    const text = renderRecordsText(buildDnsRecords("example.com", "acme-abc123"));
    const lines = text.split("\n");

    expect(lines[0]).toMatch(/^Type\s+Host\s+Value$/);
    expect(lines).toHaveLength(4);
    expect(text).toContain("acme-abc123.netlify.app");
  });
});
