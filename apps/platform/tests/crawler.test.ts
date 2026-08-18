import { describe, expect, it } from "vitest";
import {
  areAllAddressesPublic,
  inspectUrl,
  isBlockedAddress,
} from "@/lib/crawl/ssrf";
import { isAllowedByRobots, parseRobots } from "@/lib/crawl/robots";
import { extractFacts, extractPage, isSensitiveKey } from "@/lib/crawl/extract";

/**
 * The prospect crawler.
 *
 * The SSRF suite is the one that earns its keep. The crawler fetches a URL an
 * operator typed, from inside our infrastructure, which is the textbook shape
 * for reaching something on a private network that was never meant to be
 * reachable. Stage 0 rates it R10, High. Every case below is an address or a
 * URL that must be refused, and a failure here is a security defect rather
 * than a bug.
 */

describe("addresses the crawler must refuse", () => {
  it("blocks loopback", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.1.2.3")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("blocks the cloud metadata endpoint", () => {
    // The single most valuable target: it hands out credentials to anything
    // that can make an HTTP request from inside the network.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("169.254.0.1")).toBe(true);
  });

  it("blocks metadata wearing an IPv6 hat", () => {
    // ::ffff:169.254.169.254 reaches the same endpoint on any stack that
    // unwraps mapped addresses. Checking only the dotted form misses it.
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks the private ranges", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });

  it("does not over-block the ranges next to them", () => {
    // 172.15 and 172.32 are public. Blocking all of 172/8 would refuse real
    // customer sites, and a guard that cries wolf gets loosened.
    expect(isBlockedAddress("172.15.0.1")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
    expect(isBlockedAddress("192.167.1.1")).toBe(false);
    expect(isBlockedAddress("11.0.0.1")).toBe(false);
  });

  it("blocks unspecified, link-local v6, unique-local and multicast", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("::")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fd12:3456::1")).toBe(true);
    expect(isBlockedAddress("ff02::1")).toBe(true);
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
  });

  it("refuses anything it cannot parse as an address", () => {
    // Fail closed. An input we do not understand is not one we should dial.
    expect(isBlockedAddress("not-an-address")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("999.999.999.999")).toBe(true);
  });

  it("requires every resolved address to be public, not just the first", () => {
    // A name returning one public and one private address would otherwise be a
    // coin flip, and whoever controls the DNS picks the ordering.
    expect(areAllAddressesPublic(["8.8.8.8"])).toBe(true);
    expect(areAllAddressesPublic(["8.8.8.8", "127.0.0.1"])).toBe(false);
    expect(areAllAddressesPublic([])).toBe(false);
  });
});

describe("URLs the crawler must refuse", () => {
  it("takes https only", () => {
    expect(inspectUrl("https://example.com/").ok).toBe(true);
    expect(inspectUrl("http://example.com/").reason).toBe("scheme");
    expect(inspectUrl("file:///etc/passwd").reason).toBe("scheme");
    expect(inspectUrl("gopher://example.com/").reason).toBe("scheme");
  });

  it("refuses credentials in the URL", () => {
    // Parsers disagree about where the host ends in these, which is its own
    // class of bypass, and we should never be replaying someone's credentials.
    expect(inspectUrl("https://user:pass@example.com/").reason).toBe("credentials");
    expect(inspectUrl("https://user@example.com/").reason).toBe("credentials");
  });

  it("refuses non-standard ports", () => {
    expect(inspectUrl("https://example.com:8080/").reason).toBe("port");
    expect(inspectUrl("https://example.com:22/").reason).toBe("port");
    expect(inspectUrl("https://example.com:443/").ok).toBe(true);
  });

  it("refuses anything that is not a URL", () => {
    expect(inspectUrl("").reason).toBe("not_a_url");
    expect(inspectUrl("example.com").reason).toBe("not_a_url");
  });
});

describe("robots.txt", () => {
  it("honours a disallowed path", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /admin\n");
    expect(isAllowedByRobots("/admin/users", rules)).toBe(false);
    expect(isAllowedByRobots("/about", rules)).toBe(true);
  });

  it("lets a longer Allow override a Disallow", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /private\nAllow: /private/public-bit\n",
    );
    expect(isAllowedByRobots("/private/secret", rules)).toBe(false);
    expect(isAllowedByRobots("/private/public-bit/page", rules)).toBe(true);
  });

  it("allows everything when there are no rules", () => {
    expect(isAllowedByRobots("/anything", parseRobots(""))).toBe(true);
    expect(isAllowedByRobots("/anything", parseRobots("# just a comment"))).toBe(true);
  });

  it("ignores directives for other agents", () => {
    const rules = parseRobots("User-agent: BadBot\nDisallow: /\n");
    expect(isAllowedByRobots("/about", rules)).toBe(true);
  });
});

describe("reading a page", () => {
  const html = `
    <html><head>
      <title>  Acme Plumbing — Denver  </title>
      <meta name="description" content="Emergency plumbing in Denver.">
      <link rel="canonical" href="https://acme.example/">
      <script type="application/ld+json">
        {"@type":"LocalBusiness","name":"Acme Plumbing",
         "telephone":"+1-303-555-0100",
         "address":{"streetAddress":"1 Main St","addressLocality":"Denver","addressRegion":"CO"},
         "openingHours":"Mo-Fr 08:00-17:00"}
      </script>
    </head><body>
      <h1>Denver's <em>emergency</em> plumbers</h1>
      <a href="/services">Services</a>
      <a href="/about#team">About</a>
      <a href="https://facebook.com/acme">Facebook</a>
      <a href="tel:+13035550100">Call us</a>
      <a href="mailto:hi@acme.example?subject=Hi">Email</a>
      <script>var tracking = "should not appear";</script>
    </body></html>`;

  const page = extractPage(html, "https://acme.example/");

  it("pulls the page's own description of itself", () => {
    expect(page.title).toBe("Acme Plumbing — Denver");
    expect(page.metaDescription).toBe("Emergency plumbing in Denver.");
    expect(page.h1).toBe("Denver's emergency plumbers");
  });

  it("follows same-origin links only", () => {
    // Following outward turns a bounded audit of one business into an
    // unbounded crawl of the web.
    expect(page.links).toContain("https://acme.example/services");
    expect(page.links.some((l) => l.includes("facebook"))).toBe(false);
  });

  it("drops fragments so one page is not crawled twice", () => {
    expect(page.links).toContain("https://acme.example/about");
    expect(page.links.some((l) => l.includes("#"))).toBe(false);
  });

  it("does not keep script or style content", () => {
    expect(page.text).not.toContain("should not appear");
  });

  it("keeps no markup — facts, never design", () => {
    // The rule is that we never copy a prospect's site. Nothing retains the
    // structure it read, so there is no code path that could.
    expect(page.text).not.toContain("<");
    expect(page.text).not.toContain("class=");
  });
});

describe("facts a page asserts", () => {
  const html = `<html><head><title>Acme</title>
    <script type="application/ld+json">
      {"@type":"LocalBusiness","name":"Acme Plumbing","telephone":"+1-303-555-0100"}
    </script></head>
    <body><h1>Plumbers</h1><a href="tel:+13035550100">Call</a>
    <a href="mailto:hi@acme.example">Mail</a></body></html>`;

  const facts = extractFacts(extractPage(html, "https://acme.example/"), html);
  const byKey = (key: string) => facts.filter((f) => f.key === key);

  it("trusts structured data above a link, and a link above prose", () => {
    expect(byKey("business_name")[0]?.confidence).toBe(95);
    expect(byKey("phone")[0]?.confidence).toBeGreaterThanOrEqual(90);
    expect(byKey("headline")[0]?.confidence).toBe(60);
  });

  it("does not record the same fact twice from two places", () => {
    // The phone appears in both the JSON-LD and a tel: link, formatted
    // differently. Showing an operator the same number twice teaches them the
    // review queue is padded, which is how a review queue stops being read.
    expect(byKey("phone")).toHaveLength(1);
  });

  it("keeps the better-attested reading of a duplicated fact", () => {
    // The tel: link is read first but structured data is the stronger source.
    // First-wins would keep the weaker one purely by document order.
    expect(byKey("phone")[0]?.confidence).toBe(95);
    expect(byKey("phone")[0]?.value).toBe("+1-303-555-0100");
  });

  it("strips mailto parameters", () => {
    const withSubject = extractFacts(
      extractPage(`<a href="mailto:hi@acme.example?subject=Hi">m</a>`, "https://acme.example/"),
      `<a href="mailto:hi@acme.example?subject=Hi">m</a>`,
    );
    expect(withSubject.find((f) => f.key === "email")?.value).toBe("hi@acme.example");
  });

  it("marks claims that must never be auto-published", () => {
    // A wrong licence number on a real business's website is their legal
    // problem, not ours to guess at.
    expect(isSensitiveKey("licence_number")).toBe(true);
    expect(isSensitiveKey("insurance")).toBe(true);
    expect(isSensitiveKey("pricing")).toBe(true);
    expect(isSensitiveKey("years_in_business")).toBe(true);
    expect(isSensitiveKey("review_count")).toBe(true);

    expect(isSensitiveKey("phone")).toBe(false);
    expect(isSensitiveKey("business_name")).toBe(false);
  });

  it("never marks a crawled fact as verified", () => {
    // Extraction produces candidates. Only an operator accepting one can make
    // it renderable, and nothing here can shortcut that.
    expect(facts.every((f) => "confidence" in f)).toBe(true);
    expect(facts.some((f) => (f as unknown as { verified?: boolean }).verified)).toBe(false);
  });
});
