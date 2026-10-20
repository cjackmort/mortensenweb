import { describe, expect, it } from "vitest";
import { draftAd, parseServiceAreas, parseServices } from "@/lib/ads/draft";
import {
  DESCRIPTION_MAX,
  HEADLINE_MAX,
  creativeProblems,
  parseCreativeForm,
  unsupportedClaims,
} from "@/lib/ads/creative";

/**
 * Drafting an ad from what the portal already knows about the business.
 *
 * The rule that matters most: nothing in a draft that the business profile
 * does not say. An ad that claims "licensed and insured" or "#1 in Riverton"
 * on a real business's behalf is a legal problem for them, and a draft is
 * exactly where such a claim would slip in unread.
 */

const profile = {
  businessName: "Acme Plumbing",
  tagline: "Family plumbers serving the south valley",
  services: "Drain cleaning - $120\nWater heaters – from $900\n• Leak repair",
  serviceArea: "Riverton, South Jordan and Herriman",
  phone: "(801) 555-0134",
  website: "https://acmeplumbing.example",
};

const images = [
  { publicId: "img_portrait", title: "Van", width: 800, height: 1200 },
  { publicId: "img_wide", title: "Crew at work", width: 1600, height: 900 },
];

describe("parsing the profile", () => {
  it("reads one service per line, without prices or bullets", () => {
    expect(parseServices(profile.services)).toEqual(["Drain cleaning", "Water heaters", "Leak repair"]);
  });

  it("splits areas on commas and 'and'", () => {
    expect(parseServiceAreas(profile.serviceArea)).toEqual(["Riverton", "South Jordan", "Herriman"]);
  });

  it("reads nothing from empty fields", () => {
    expect(parseServices(undefined)).toEqual([]);
    expect(parseServiceAreas("")).toEqual([]);
  });
});

describe("draftAd", () => {
  const draft = draftAd({ profile, organizationName: "Acme Plumbing LLC", siteUrl: null, images });

  it("writes three to five headlines within Google's 30 characters", () => {
    expect(draft.headlines.length).toBeGreaterThanOrEqual(3);
    expect(draft.headlines.length).toBeLessThanOrEqual(5);
    for (const headline of draft.headlines) expect(headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
  });

  it("writes two descriptions within Google's 90 characters", () => {
    expect(draft.descriptions).toHaveLength(2);
    for (const line of draft.descriptions) expect(line.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it("leads with the business's own name and its services in its own area", () => {
    expect(draft.headlines[0]).toBe("Acme Plumbing");
    expect(draft.headlines).toContain("Drain Cleaning in Riverton");
  });

  it("makes no claim the profile does not support", () => {
    const text = [...draft.headlines, ...draft.descriptions].join(" ");
    expect(unsupportedClaims(text, profile)).toEqual([]);
    expect(text).not.toMatch(/licensed|insured|best|#1|guarantee|free|award|years/i);
  });

  it("never puts the phone number in the ad text, which Google refuses", () => {
    const text = [...draft.headlines, ...draft.descriptions].join(" ");
    expect(text).not.toMatch(/555/);
    expect(draft.phone).toBe("(801) 555-0134");
  });

  it("targets the areas the business serves", () => {
    expect(draft.targetAreas).toEqual(["Riverton", "South Jordan", "Herriman"]);
  });

  it("asks for a call when there is a phone and no booking link", () => {
    expect(draft.callToAction).toBe("call");
  });

  it("sends clicks to the website", () => {
    expect(draft.finalUrl).toBe("https://acmeplumbing.example");
  });

  it("prefers the portal's own site address over the profile's", () => {
    const own = draftAd({ profile, organizationName: "Acme", siteUrl: "https://acme.mortensenweb.site", images });
    expect(own.finalUrl).toBe("https://acme.mortensenweb.site");
  });

  it("picks a landscape photo from the library", () => {
    expect(draft.imageAssetPublicId).toBe("img_wide");
  });

  it("records the facts it was given", () => {
    expect(draft.facts).toMatchObject({
      businessName: "Acme Plumbing",
      services: profile.services,
      serviceArea: profile.serviceArea,
    });
  });

  it("asks for a booking when there is a booking link", () => {
    const booked = draftAd({
      profile: { ...profile, bookingUrl: "https://book.example/acme" },
      organizationName: "Acme",
      siteUrl: null,
      images: [],
    });
    expect(booked.callToAction).toBe("book");
    expect(booked.imageAssetPublicId).toBeNull();
  });

  it("still drafts three headlines from a nearly empty profile, using the organisation's name", () => {
    const bare = draftAd({ profile: {}, organizationName: "Globex", siteUrl: null, images: [] });
    expect(bare.headlines.length).toBeGreaterThanOrEqual(3);
    expect(bare.headlines[0]).toBe("Globex");
    expect(bare.missing).toEqual(expect.arrayContaining(["services", "serviceArea"]));
    expect(unsupportedClaims(bare.headlines.join(" "), {})).toEqual([]);
  });

  it("never repeats a description, which Google refuses", () => {
    const thinProfiles: Array<Record<string, string>> = [{}, { phone: "801 555 0134" }, { serviceArea: "Riverton" }];
    for (const profileCase of thinProfiles) {
      const thin = draftAd({ profile: profileCase, organizationName: "Globex", siteUrl: null, images: [] });
      expect(new Set(thin.descriptions).size).toBe(2);
      expect(creativeProblems({ ...thin, finalUrl: "https://globex.example" })).toEqual([]);
    }
  });

  it("shortens a long business name rather than cutting a word in half", () => {
    const long = draftAd({
      profile: { ...profile, businessName: "Acme Plumbing, Heating and Air Conditioning of Utah" },
      organizationName: "x",
      siteUrl: null,
      images: [],
    });
    for (const headline of long.headlines) {
      expect(headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
      expect(headline).not.toMatch(/\s\S{1,2}$/);
    }
  });
});

describe("creativeProblems", () => {
  const good = {
    headlines: ["Acme Plumbing", "Drain Cleaning in Riverton", "Call Today"],
    descriptions: ["Drain cleaning and leak repair in Riverton.", "Call Acme Plumbing today."],
    finalUrl: "https://acmeplumbing.example",
  };

  it("passes a draft that keeps Google's rules", () => {
    expect(creativeProblems(good)).toEqual([]);
  });

  it("refuses fewer than three headlines", () => {
    expect(creativeProblems({ ...good, headlines: ["Acme", "Plumbing"] })).toContainEqual(
      expect.stringMatching(/three headlines/),
    );
  });

  it("refuses a headline over 30 characters", () => {
    expect(creativeProblems({ ...good, headlines: [...good.headlines, "x".repeat(31)] })).toContainEqual(
      expect.stringMatching(/30 characters/),
    );
  });

  it("refuses an exclamation mark in a headline", () => {
    expect(creativeProblems({ ...good, headlines: ["Acme Plumbing!", ...good.headlines.slice(1)] })).toContainEqual(
      expect.stringMatching(/exclamation/),
    );
  });

  it("refuses a phone number in the ad text", () => {
    expect(
      creativeProblems({ ...good, descriptions: ["Call 801-555-0134 now.", good.descriptions[1]!] }),
    ).toContainEqual(expect.stringMatching(/phone number/));
  });

  it("refuses shouting in capitals", () => {
    expect(creativeProblems({ ...good, headlines: ["ACME PLUMBING", ...good.headlines.slice(1)] })).toContainEqual(
      expect.stringMatching(/capital/),
    );
  });

  it("refuses two descriptions that say the same thing", () => {
    expect(creativeProblems({ ...good, descriptions: ["Call us.", "call us."] })).toContainEqual(
      expect.stringMatching(/descriptions are the same/),
    );
  });

  it("refuses a landing page that is not a web address", () => {
    expect(creativeProblems({ ...good, finalUrl: "acme" })).toContainEqual(expect.stringMatching(/web address/));
  });
});

describe("unsupportedClaims", () => {
  it("flags a claim the profile does not make", () => {
    expect(unsupportedClaims("Licensed & insured plumbers", { businessName: "Acme" })).toEqual(["licensed", "insured"]);
  });

  it("allows a claim the profile does make", () => {
    expect(unsupportedClaims("Licensed & insured plumbers", { credentials: "Licensed and insured in Utah" })).toEqual([]);
  });

  it("flags a number the profile does not contain", () => {
    expect(unsupportedClaims("Over 20 years serving Riverton", { serviceArea: "Riverton" })).toEqual(
      expect.arrayContaining(["20", "years"]),
    );
  });
});

describe("parseCreativeForm", () => {
  function form(entries: Record<string, string | string[]>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) {
      for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
    }
    return data;
  }

  it("reads the lines, dropping empty ones and trimming", () => {
    const parsed = parseCreativeForm(
      form({
        name: " Spring ad ",
        headline: ["Acme Plumbing", "  ", " Drain Cleaning "],
        description: ["One.", ""],
        callToAction: "call",
        finalUrl: "https://acme.example",
        phone: "801 555 0134",
        targetAreas: "Riverton, Herriman",
        imageAssetPublicId: "",
      }),
    );
    expect(parsed).toEqual({
      name: "Spring ad",
      headlines: ["Acme Plumbing", "Drain Cleaning"],
      descriptions: ["One."],
      callToAction: "call",
      finalUrl: "https://acme.example",
      phone: "801 555 0134",
      targetAreas: ["Riverton", "Herriman"],
      imageAssetPublicId: null,
    });
  });

  it("drops a call to action it does not know", () => {
    expect(parseCreativeForm(form({ name: "x", callToAction: "download" })).callToAction).toBeNull();
  });
});
