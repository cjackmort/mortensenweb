import { describe, expect, it } from "vitest";
import { suggestProfile } from "@/lib/profile-autofill";

/**
 * Reading a client's existing website into General information.
 *
 * Suggestions only: the operator sees them in the form and saves. The failures
 * worth testing are wrong facts in the wrong field, and claims the site must
 * never publish on the strength of having read them somewhere.
 */

const HOME = `<!doctype html><html><head>
<title>Northwind Comfort | Heating &amp; Cooling in Denver</title>
<meta name="description" content="Furnace and AC repair across the Denver metro, same-day.">
<script type="application/ld+json">{
  "@context": "https://schema.org", "@type": "HVACBusiness",
  "name": "Northwind Comfort Systems",
  "telephone": "+1-303-555-0100",
  "email": "hello@northwind.example",
  "address": {"streetAddress": "12 Elm St", "addressLocality": "Denver", "addressRegion": "CO", "postalCode": "80202"},
  "openingHours": ["Mo-Fr 08:00-17:00", "Sa 09:00-12:00"],
  "award": "Best of Denver 2024"
}</script>
</head><body>
<h1>Warm in winter, cool in summer</h1>
<a href="tel:+13035550100">Call us</a>
<a href="https://calendly.com/northwind/estimate">Book an estimate</a>
<a href="https://www.facebook.com/northwindcomfort">Facebook</a>
<a href="https://instagram.com/northwind.comfort/">Instagram</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
<a href="https://www.yelp.com/biz/northwind-comfort-denver">Yelp</a>
<a href="https://g.page/northwind-comfort">Google</a>
<p>Licensed and insured, license #HV-12345. Serving Denver since 1998.</p>
</body></html>`;

describe("suggestProfile", () => {
  const found = suggestProfile([{ url: "https://northwind.example/", html: HOME }]);

  it("takes the business's own structured description first", () => {
    expect(found.businessName).toBe("Northwind Comfort Systems");
    expect(found.phone).toBe("+1-303-555-0100");
    expect(found.email).toBe("hello@northwind.example");
    expect(found.address).toBe("12 Elm St, Denver, CO 80202");
    expect(found.hours).toBe("Mo-Fr 08:00-17:00\nSa 09:00-12:00");
  });

  it("uses the meta description as the one-liner", () => {
    expect(found.tagline).toBe("Furnace and AC repair across the Denver metro, same-day.");
  });

  it("finds the booking link and the profiles they link to, not share buttons", () => {
    expect(found.bookingUrl).toBe("https://calendly.com/northwind/estimate");
    expect(found.facebook).toBe("https://www.facebook.com/northwindcomfort");
    expect(found.instagram).toBe("https://instagram.com/northwind.comfort/");
    expect(found.yelp).toBe("https://www.yelp.com/biz/northwind-comfort-denver");
    expect(found.googleBusiness).toBe("https://g.page/northwind-comfort");
  });

  it("records the site it read as their current website", () => {
    expect(found.website).toBe("https://northwind.example/");
  });

  it("never fills claims that need confirming", () => {
    // A licence number, an award and a founding year read off a page are
    // exactly what the site must not republish without someone checking.
    expect(found.credentials).toBeUndefined();
    expect(found.awards).toBeUndefined();
    expect(found.founded).toBeUndefined();
  });

  it("falls back to the page title when there is no structured name", () => {
    const plain = suggestProfile([
      { url: "https://plain.example/", html: "<title>Plain Bakery | Fresh bread daily</title><a href='mailto:hi@plain.example'>mail</a>" },
    ]);
    expect(plain.businessName).toBe("Plain Bakery");
    expect(plain.email).toBe("hi@plain.example");
  });

  it("prefers what the home page says, and fills gaps from other pages", () => {
    const merged = suggestProfile([
      { url: "https://plain.example/", html: "<title>Plain Bakery</title><a href='tel:303-555-0111'>call</a>" },
      { url: "https://plain.example/contact", html: "<a href='tel:303-555-0999'>other</a><a href='mailto:orders@plain.example'>m</a>" },
    ]);
    expect(merged.phone).toBe("303-555-0111");
    expect(merged.email).toBe("orders@plain.example");
  });

  it("returns nothing for a page with nothing on it", () => {
    expect(suggestProfile([{ url: "https://empty.example/", html: "<html></html>" }])).toEqual({
      website: "https://empty.example/",
    });
  });
});
