import { describe, expect, it } from "vitest";
import { connectSiteJson } from "@/lib/site-json/connect";
import { fillProfileGaps, profileFromSiteJson } from "@/lib/site-json/profile";
import {
  describesBusiness,
  isTemplateContent,
  kindsFromSiteJson,
  looksLikePlaceholder,
  parseSiteJson,
  siteDomain,
} from "@/lib/site-json/read";

/**
 * Reading a site's `site.json` into the portal, and writing the portal's ids
 * back. The rules that matter: nothing placeholder-shaped reaches General
 * information, nothing a person typed is overwritten, and an id copied from
 * the site a concept was based on is replaced.
 */

function parsed(json: unknown) {
  const result = parseSiteJson(JSON.stringify(json));
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("parseSiteJson", () => {
  it("drops a malformed field instead of the whole file", () => {
    const { site } = parsed({ meta: { businessName: "Basin View" }, contact: { hours: "Mon-Fri 9-5" } });
    expect(site.meta?.businessName).toBe("Basin View");
    expect(site.contact?.hours).toBeUndefined();
  });

  it("says so when the file is not JSON or not an object", () => {
    expect(parseSiteJson("{nope").ok).toBe(false);
    expect(parseSiteJson("[1,2]").ok).toBe(false);
  });
});

describe("what counts as not a real detail", () => {
  it("recognises the fictional 555-01xx range, documentation domains and markers", () => {
    for (const value of ["(973) 555-0142", "555.0100", "info@example.com", "TODO", "[Your phone]", "XXXX"]) {
      expect(looksLikePlaceholder(value), value).toBe(true);
    }
    for (const value of ["(307) 555-2100", "hello@basinviewdesigns.com", "Tue-Sat 10:00 AM–5:00 PM"]) {
      expect(looksLikePlaceholder(value), value).toBe(false);
    }
  });

  it("recognises the template's own demo business", () => {
    expect(isTemplateContent(parsed({ meta: { businessName: "Acme Plumbing & Heating" } }).site)).toBe(true);
    expect(isTemplateContent(parsed({ meta: { businessName: "Basin View Designs" } }).site)).toBe(false);
  });

  it("believes a file only about the business it is converting", () => {
    const about = (name?: string) => parsed({ meta: name === undefined ? {} : { businessName: name } }).site;
    expect(describesBusiness(about("Basin View Designs LLC"), "Basin View Designs")).toBe(true);
    expect(describesBusiness(about("Hair By Graci"), "hair by graci")).toBe(true);
    expect(describesBusiness(about("Café Rosé"), "Cafe Rose")).toBe(true);
    expect(describesBusiness(about("Scott Mortensen Fine Arts"), "Basin View Designs")).toBe(false);
    expect(describesBusiness(about(), "Basin View Designs")).toBe(false);
  });

  it("reads meta.domain as a bare hostname, or not at all", () => {
    expect(siteDomain(parsed({ meta: { domain: "https://www.BasinView.com/about" } }).site)).toBe("basinview.com");
    expect(siteDomain(parsed({ meta: { domain: "acmeplumbing.com" } }).site)).toBeNull();
    expect(siteDomain(parsed({ meta: { domain: "not a domain" } }).site)).toBeNull();
  });
});

describe("profileFromSiteJson", () => {
  const site = parsed({
    meta: { businessName: "Basin View Designs", domain: "basinviewdesigns.com" },
    seo: { description: "Florals for weddings", serviceArea: ["Cody", "Powell"] },
    brand: { colorPrimary: "#4a6b3a", radius: 14 },
    contact: {
      phone: "(307) 555-2100",
      email: "not an email",
      address: { street: "12 Sheridan Ave", city: "Cody", state: "WY", zip: "82414" },
      hours: [{ days: "Tue-Sat", open: "10:00 AM", close: "5:00 PM" }],
      social: { facebook: "https://facebook.com/basinview", instagram: "", google: "TODO" },
    },
    hero: { secondaryCta: { href: "/contact" } },
    services: [{ title: "Wedding florals" }, { title: "Event installs" }],
  }).site;

  it("maps the file onto General information", () => {
    const { details } = profileFromSiteJson(site);
    expect(details).toEqual({
      businessName: "Basin View Designs",
      tagline: "Florals for weddings",
      phone: "(307) 555-2100",
      address: "12 Sheridan Ave, Cody, WY 82414",
      hours: "Tue-Sat 10:00 AM–5:00 PM",
      services: "Wedding florals\nEvent installs",
      serviceArea: "Cody, Powell",
      bookingUrl: "https://basinviewdesigns.com/contact",
      website: "https://basinviewdesigns.com",
      facebook: "https://facebook.com/basinview",
      brand: "colorPrimary: #4a6b3a",
    });
  });

  it("names what it left out", () => {
    const { rejected } = profileFromSiteJson(site);
    expect(rejected.sort()).toEqual(["email", "googleBusiness"]);
  });

  it("points the booking link at /book when the site takes bookings", () => {
    const booking = parsed({ meta: { domain: "graci.com" }, booking: { enabled: true } }).site;
    expect(profileFromSiteJson(booking).details.bookingUrl).toBe("https://graci.com/book");
  });
});

describe("fillProfileGaps", () => {
  it("fills only what is empty and names what it kept", () => {
    const result = fillProfileGaps(
      { phone: "307-555-9999", about: "Typed by the client." },
      { phone: "(307) 555-2100", email: "hello@basinviewdesigns.com" },
    );
    expect(result.details).toEqual({
      phone: "307-555-9999",
      about: "Typed by the client.",
      email: "hello@basinviewdesigns.com",
    });
    expect(result.filled).toEqual(["email"]);
    expect(result.kept).toEqual(["phone"]);
  });
});

describe("kindsFromSiteJson", () => {
  it("is undefined where the file says nothing", () => {
    expect(kindsFromSiteJson(parsed({ booking: { enabled: true } }).site)).toEqual({ booking: true, shop: undefined });
  });
});

describe("connectSiteJson", () => {
  const ids = {
    umamiWebsiteId: "8b6f2a0e-3c4d-4e5f-9a1b-2c3d4e5f6a7b",
    umamiScriptUrl: "https://umami.example.test/script.js",
    sitePublicId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  };

  it("replaces ids copied from another site and keeps everything else", () => {
    const source =
      JSON.stringify(
        {
          meta: { businessName: "Basin View" },
          analytics: { umamiWebsiteId: "someone-elses", umamiScriptUrl: "" },
          booking: { enabled: true, portal: { siteId: "OLD" } },
          shop: { enabled: false, siteId: "" },
        },
        null,
        4,
      ) + "\n";
    const { raw } = parsed(JSON.parse(source));

    const result = connectSiteJson(source, raw, ids);
    const written = JSON.parse(result.text);

    expect(result.changed).toEqual([
      "analytics.umamiWebsiteId",
      "analytics.umamiScriptUrl",
      "booking.portal.siteId",
      "shop.siteId",
    ]);
    expect(written.meta).toEqual({ businessName: "Basin View" });
    expect(written.analytics.umamiWebsiteId).toBe(ids.umamiWebsiteId);
    expect(written.booking.portal.siteId).toBe(ids.sitePublicId);
    // The file's own indentation and trailing newline survive.
    expect(result.text).toMatch(/^\{\n {4}"meta"/);
    expect(result.text.endsWith("}\n")).toBe(true);
  });

  it("adds no booking or shop block a site does not have", () => {
    const source = JSON.stringify({ analytics: {} });
    const result = connectSiteJson(source, JSON.parse(source), ids);
    expect(JSON.parse(result.text)).toEqual({ analytics: { umamiWebsiteId: ids.umamiWebsiteId } });
  });

  it("flags a site that would load a self-hosted Umami's id from Cloud", () => {
    const source = JSON.stringify({ analytics: { umamiWebsiteId: "" } });
    expect(connectSiteJson(source, JSON.parse(source), ids).scriptOriginMismatch).toBe(true);

    const cloud = { ...ids, umamiScriptUrl: "https://cloud.umami.is/script.js" };
    expect(connectSiteJson(source, JSON.parse(source), cloud).scriptOriginMismatch).toBe(false);
  });

  it("changes nothing when the file already says it all", () => {
    const source = JSON.stringify({ analytics: { umamiWebsiteId: ids.umamiWebsiteId } });
    const result = connectSiteJson(source, JSON.parse(source), { ...ids, umamiScriptUrl: null });
    expect(result).toEqual({ text: source, changed: [], scriptOriginMismatch: false });
  });
});
