import { describe, expect, it } from "vitest";
import {
  draftShowcase,
  graphicCaption,
  validateShowcaseWords,
  validateWording,
} from "@/lib/showcase/draft";
import { siteRequestBrief } from "@/lib/showcase/site-brief";
import { googlePostFor, GOOGLE_SUMMARY_LIMIT } from "@/lib/showcase/google-post";

/**
 * The drafted wording. The rule that matters most here is the negative one:
 * nothing appears in a draft that the client did not say or that General
 * information does not hold. A test below feeds in a profile with every
 * claim-shaped field filled and asserts none of them leak into the text.
 */

const profile = {
  businessName: "Northwind Comfort Systems",
  phone: "555-0100",
};

describe("draftShowcase", () => {
  it("writes a past-tense job as something the business did, in the town", () => {
    const draft = draftShowcase({ job: "Replaced a 20-year-old furnace", town: "Riverton", profile });
    expect(draft.title).toBe("Replaced a 20-year-old furnace in Riverton");
    expect(draft.writeUp).toMatch(/^We replaced a 20-year-old furnace in Riverton\./);
  });

  it("keeps a noun-phrase job as its own sentence", () => {
    const draft = draftShowcase({ job: "Furnace replacement", town: "Riverton", profile });
    expect(draft.title).toBe("Furnace replacement in Riverton");
    expect(draft.writeUp).toMatch(/^Furnace replacement in Riverton\./);
  });

  it("does not mistake a short noun ending in -ed for a verb", () => {
    const draft = draftShowcase({ job: "Shed build", town: "Herriman", profile });
    expect(draft.writeUp).toMatch(/^Shed build in Herriman\./);
  });

  it("does not repeat the town when the job already names it", () => {
    const draft = draftShowcase({ job: "New patio for a Riverton family", town: "Riverton", profile });
    expect(draft.title).toBe("New patio for a Riverton family");
  });

  it("includes the client's notes word for word", () => {
    const draft = draftShowcase({
      job: "Replaced a furnace",
      town: "Riverton",
      notes: "the old one was original to the house",
      profile,
    });
    expect(draft.writeUp).toContain("The old one was original to the house.");
  });

  it("closes with the phone number from General information", () => {
    const draft = draftShowcase({ job: "Replaced a furnace", town: "Riverton", profile });
    expect(draft.writeUp).toMatch(/Call 555-0100\.$/);
    expect(draft.caption).toContain("555-0100");
  });

  it("falls back to the booking link, and to no call to action at all", () => {
    const booking = draftShowcase({
      job: "Replaced a furnace",
      town: "Riverton",
      profile: { bookingUrl: "https://book.example/northwind" },
    });
    expect(booking.writeUp).toContain("https://book.example/northwind");

    const bare = draftShowcase({ job: "Replaced a furnace", town: "Riverton", profile: {} });
    expect(bare.writeUp).toBe("We replaced a furnace in Riverton.");
  });

  it("never brings in facts the client did not give", () => {
    const draft = draftShowcase({
      job: "Replaced a furnace",
      town: "Riverton",
      profile: {
        ...profile,
        founded: "1998",
        credentials: "Licensed and insured, Utah #12345",
        awards: "Best of State 2025",
        about: "Family-owned for three generations",
      },
    });
    const all = `${draft.title} ${draft.writeUp} ${draft.caption}`;
    for (const claim of ["1998", "12345", "Licensed", "Best of State", "generations"]) {
      expect(all).not.toContain(claim);
    }
  });

  it("does not lower-case an acronym at the start of the job", () => {
    const draft = draftShowcase({ job: "HVAC tune-up", town: "Riverton", profile: {} });
    expect(draft.writeUp).toBe("HVAC tune-up in Riverton.");
  });
});

describe("validateShowcaseWords", () => {
  it("requires the job and the town", () => {
    expect(validateShowcaseWords({ job: "", town: "Riverton" })).toEqual({
      ok: false,
      message: "Say what the job was, in a few words.",
    });
    expect(validateShowcaseWords({ job: "Replaced a furnace", town: " " })).toEqual({
      ok: false,
      message: "Say which town the job was in.",
    });
  });

  it("trims and collapses what it accepts", () => {
    expect(validateShowcaseWords({ job: "  Replaced   a furnace. ", town: "Riverton ", notes: "  " })).toEqual({
      ok: true,
      words: { job: "Replaced a furnace", town: "Riverton", notes: null },
    });
  });

  it("refuses an essay", () => {
    const result = validateShowcaseWords({ job: "x".repeat(161), town: "Riverton" });
    expect(result.ok).toBe(false);
  });
});

describe("validateWording", () => {
  it("requires a title and a write-up", () => {
    expect(validateWording({ title: "", writeUp: "Text", caption: "Text" }).ok).toBe(false);
    expect(validateWording({ title: "Title", writeUp: " ", caption: "Text" }).ok).toBe(false);
  });

  it("keeps the client's paragraph breaks", () => {
    const result = validateWording({ title: "Title", writeUp: "One.\r\n\r\nTwo.", caption: "Cap" });
    expect(result).toEqual({ ok: true, wording: { title: "Title", writeUp: "One.\n\nTwo.", caption: "Cap" } });
  });
});

describe("graphicCaption", () => {
  it("leaves a short title alone", () => {
    expect(graphicCaption("Replaced a furnace in Riverton")).toBe("Replaced a furnace in Riverton");
  });

  it("shortens a long title at a word, never mid-word", () => {
    const caption = graphicCaption(
      "Replaced a twenty-year-old furnace and the ductwork and the thermostat for a family in Riverton",
    );
    expect(caption.length).toBeLessThanOrEqual(80);
    expect(caption.endsWith("…")).toBe(true);
    expect(caption).not.toMatch(/\s…$/);
  });
});

describe("siteRequestBrief", () => {
  const showcase = {
    title: "Replaced a furnace in Riverton",
    writeUp: "We replaced a furnace in Riverton.\n\nCall 555-0100.",
    town: "Riverton",
  };

  it("asks for a project page with the approved wording, as written", () => {
    const brief = siteRequestBrief(showcase, [{ role: "photo" }, { role: "photo" }]);
    expect(brief.title).toBe("Add a project: Replaced a furnace in Riverton");
    expect(brief.description).toContain("project page");
    expect(brief.description).toContain("We replaced a furnace in Riverton.");
    expect(brief.description).toMatch(/do not add/i);
    expect(brief.description).toContain("2 photos");
  });

  it("names the before and after photos by their position", () => {
    const brief = siteRequestBrief(showcase, [{ role: "before" }, { role: "after" }, { role: "photo" }]);
    expect(brief.description).toContain("Photo 1 is before and photo 2 is after");
  });

  it("fits the request title in the column the request list shows", () => {
    const brief = siteRequestBrief({ ...showcase, title: "x".repeat(300) }, []);
    expect(brief.title.length).toBeLessThanOrEqual(120);
  });
});

describe("googlePostFor", () => {
  it("posts the write-up with a call button when there is a phone number", () => {
    const post = googlePostFor({ writeUp: "We replaced a furnace.", coverAssetPublicId: "asset1" }, profile);
    expect(post).toEqual({
      summary: "We replaced a furnace.",
      mediaAssetPublicId: "asset1",
      cta: { actionType: "CALL" },
    });
  });

  it("uses the booking link when there is no phone", () => {
    const post = googlePostFor(
      { writeUp: "We replaced a furnace.", coverAssetPublicId: null },
      { bookingUrl: "https://book.example/n" },
    );
    expect(post.cta).toEqual({ actionType: "BOOK", url: "https://book.example/n" });
  });

  it("keeps the summary inside Google's limit, ending on a whole sentence", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const post = googlePostFor({ writeUp: long, coverAssetPublicId: null }, {});
    expect(post.summary.length).toBeLessThanOrEqual(GOOGLE_SUMMARY_LIMIT);
    expect(post.summary.endsWith(".")).toBe(true);
  });
});
