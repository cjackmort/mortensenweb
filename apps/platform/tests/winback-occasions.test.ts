import { describe, expect, it } from "vitest";
import {
  businessTypeOf,
  composeDraft,
  OCCASIONS,
  suggestOccasions,
} from "@/lib/winback/occasions";

/**
 * The drafts the portal proposes.
 *
 * What would go wrong quietly: a carpet cleaner offered a furnace reminder; a
 * draft that states something about the business nobody told us (a year
 * founded, a discount, a review count) and that the client approves without
 * noticing; and suggestions that ignore the time of year.
 */

const hvacProfile = {
  businessName: "Peak Heating & Air",
  tagline: "Furnace and A/C repair in Riverton",
  phone: "801-555-0142",
  bookingUrl: "https://peak.example/book",
  services: "Furnace tune-up - $89\nA/C repair\nWater heaters",
};

describe("businessTypeOf", () => {
  it("reads the trade from the profile and the industry", () => {
    expect(businessTypeOf({ industry: "HVAC", details: {} })).toBe("hvac");
    expect(businessTypeOf({ industry: null, details: hvacProfile })).toBe("hvac");
    expect(businessTypeOf({ industry: null, details: { tagline: "Carpet and upholstery cleaning" } })).toBe("cleaning");
    expect(businessTypeOf({ industry: "Lawn care", details: {} })).toBe("landscaping");
    expect(businessTypeOf({ industry: "Dance studio", details: {} })).toBe("lessons");
  });

  it("falls back to a general business rather than guessing a trade", () => {
    expect(businessTypeOf({ industry: null, details: {} })).toBe("general");
    expect(businessTypeOf({ industry: "Consulting", details: { tagline: "Bookkeeping" } })).toBe("general");
  });
});

describe("suggestOccasions", () => {
  it("offers what is in season for that trade", () => {
    const october = new Date("2026-10-14T12:00:00Z");
    const keys = suggestOccasions("hvac", october).map((o) => o.key);
    expect(keys).toContain("hvac-furnace");
    expect(keys).not.toContain("hvac-ac");
  });

  it("offers the spring one in spring", () => {
    const april = new Date("2026-04-10T12:00:00Z");
    const keys = suggestOccasions("hvac", april).map((o) => o.key);
    expect(keys).toContain("hvac-ac");
    expect(keys).not.toContain("hvac-furnace");
  });

  it("always has something to offer, whatever the trade and month", () => {
    for (let month = 0; month < 12; month += 1) {
      const when = new Date(Date.UTC(2026, month, 15, 12));
      for (const type of ["hvac", "cleaning", "general", "lessons"] as const) {
        expect(suggestOccasions(type, when).length).toBeGreaterThan(0);
      }
    }
  });

  it("never offers another trade's occasion", () => {
    const keys = suggestOccasions("cleaning", new Date("2026-10-14T12:00:00Z")).map((o) => o.key);
    expect(keys.some((k) => k.startsWith("hvac"))).toBe(false);
  });

  it("names every occasion uniquely", () => {
    const keys = OCCASIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("composeDraft", () => {
  const occasion = OCCASIONS.find((o) => o.key === "hvac-furnace")!;

  it("uses the business's own name, phone and booking link", () => {
    const draft = composeDraft(occasion, hvacProfile);
    expect(draft.body).toContain("Peak Heating & Air");
    expect(draft.body).toContain("801-555-0142");
    expect(draft.body).toContain("https://peak.example/book");
    expect(draft.body.startsWith("Hi {first_name},")).toBe(true);
  });

  it("names a service only when the profile lists a matching one", () => {
    expect(composeDraft(occasion, hvacProfile).body).toMatch(/ask about our furnace tune-up./i);
    // The price after the dash is the profile's, but a draft does not quote it:
    // prices change, and an approved email with a stale one is a promise.
    expect(composeDraft(occasion, hvacProfile).body).not.toContain("$89");
    expect(composeDraft(occasion, { businessName: "Peak" }).body).not.toMatch(/tune-up/i);
  });

  it("asks them to reply when there is no phone or booking link", () => {
    const draft = composeDraft(occasion, { businessName: "Peak" });
    expect(draft.body).toMatch(/reply to this email/i);
    expect(draft.body).not.toMatch(/call us/i);
  });

  it("never offers a discount or states a fact the profile did not give", () => {
    for (const o of OCCASIONS) {
      const draft = composeDraft(o, { businessName: "Peak" });
      expect(draft.offer).toBeNull();
      expect(draft.body).not.toMatch(/%|\$\d|since \d{4}|years? (of experience|in business)|reviews?|award|licensed|certified/i);
      expect(draft.subject).not.toMatch(/%|\$\d/);
    }
  });

  it("falls back to a neutral sign-off when the profile has no name", () => {
    const draft = composeDraft(occasion, {});
    expect(draft.body).not.toContain("undefined");
    expect(draft.body).not.toContain("null");
  });
});
