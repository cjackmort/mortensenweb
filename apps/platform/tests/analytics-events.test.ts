import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  categoriseEvents,
  classifyEvent,
  isPortalEvent,
} from "@/lib/analytics/events";

/**
 * Event classification.
 *
 * The failure this replaces: everything that did not begin `photo:` was
 * rendered under a heading reading "Getting in touch", so a portfolio tile
 * click was reported to the client as an enquiry. Every test below is a
 * specific thing that must not be claimed.
 */

describe("classifyEvent", () => {
  it("treats a phone tap as intent, not a completed call", () => {
    const event = classifyEvent("called", 12);
    expect(event.category).toBe("contact_intent");
    // We saw a tap. On a desktop browser it may have opened nothing at all.
    expect(event.label.toLowerCase()).toContain("tapped");
    expect(event.label.toLowerCase()).not.toMatch(/\bcalls?\b/);
  });

  it("treats an email tap as intent", () => {
    expect(classifyEvent("emailed", 3).category).toBe("contact_intent");
  });

  it("does not treat a submit-button click as a received enquiry", () => {
    // `enquiry sent` fires on click — before validation, before the POST, and
    // regardless of whether anything arrives.
    const event = classifyEvent("enquiry sent", 9);
    expect(event.category).toBe("contact_intent");
    expect(event.category).not.toBe("confirmed_inquiry");
    expect(event.label.toLowerCase()).toContain("pressed send");
  });

  it("does not treat a portfolio click as an enquiry", () => {
    // This is the exact miscount the old code produced.
    const event = classifyEvent("work: Northwind Comfort", 40);
    expect(event.category).toBe("navigation");
    expect(event.category).not.toBe("contact_intent");
    expect(event.subject).toBe("Northwind Comfort");
  });

  it("does not treat a shop click as a purchase", () => {
    const event = classifyEvent("shop: Prints", 5);
    expect(event.category).toBe("navigation");
    expect(event.label.toLowerCase()).not.toContain("sold");
    expect(event.label.toLowerCase()).not.toContain("purchase");
  });

  it("reads the subject out of a prefixed event", () => {
    const event = classifyEvent("photo: Chief in Waiting", 88);
    expect(event.category).toBe("content_interest");
    expect(event.subject).toBe("Chief in Waiting");
    expect(event.label).toBe("Chief in Waiting");
  });

  it("classifies a CTA as navigation", () => {
    expect(classifyEvent("cta: hero start a project", 4).category).toBe("navigation");
  });

  it("puts an unknown event in `other` and keeps its raw name", () => {
    // Never folded into a category it was not shown to belong to. An unmapped
    // event is a gap in the registry and should be visible to whoever can fix
    // it, not quietly counted as something else.
    const event = classifyEvent("newsletter signup", 2);
    expect(event.category).toBe("other");
    expect(event.id).toBeNull();
    expect(event.label).toBe("newsletter signup");
  });

  it("matches case-insensitively but preserves the original name", () => {
    const event = classifyEvent("Photo: Sunrise", 1);
    expect(event.category).toBe("content_interest");
    expect(event.raw).toBe("Photo: Sunrise");
  });

  it("survives a prefix with nothing after it", () => {
    const event = classifyEvent("photo:", 1);
    expect(event.category).toBe("content_interest");
    expect(event.subject).toBeNull();
  });

  it("never puts anything in confirmed_inquiry from a click", () => {
    // The only category that claims an outcome, and no tracked event may reach
    // it — it is populated from backend records only.
    const clicks = [
      "called",
      "emailed",
      "enquiry sent",
      "work: X",
      "photo: Y",
      "cta: z",
      "shop: a",
      "anything at all",
    ];
    for (const name of clicks) {
      expect(classifyEvent(name, 1).category, name).not.toBe("confirmed_inquiry");
    }
  });
});

describe("isPortalEvent", () => {
  it("recognises portal activity", () => {
    // A client uploading a photograph to their library is not a visitor to
    // their own website, and counting it would inflate the figures they use to
    // judge whether the site is working.
    expect(isPortalEvent("media: upload started")).toBe(true);
    expect(isPortalEvent("portal: opened media library")).toBe(true);
    expect(isPortalEvent("request: submitted")).toBe(true);
  });

  it("leaves website events alone", () => {
    expect(isPortalEvent("called")).toBe(false);
    expect(isPortalEvent("photo: Chief in Waiting")).toBe(false);
  });
});

describe("categoriseEvents", () => {
  const rows = [
    { label: "photo: Chief in Waiting", value: 88 },
    { label: "photo: Sunrise", value: 40 },
    { label: "called", value: 12 },
    { label: "emailed", value: 5 },
    { label: "work: Northwind", value: 30 },
    { label: "newsletter signup", value: 2 },
    { label: "media: upload finished", value: 400 },
  ];

  it("keeps portal events out of the client's report entirely", () => {
    const groups = categoriseEvents(rows);
    const everyEvent = groups.flatMap((g) => g.events.map((e) => e.raw));
    expect(everyEvent).not.toContain("media: upload finished");
  });

  it("separates contact intent from content and navigation", () => {
    const groups = categoriseEvents(rows);
    const byCategory = Object.fromEntries(groups.map((g) => [g.category, g]));

    expect(byCategory.contact_intent!.events.map((e) => e.raw).sort()).toEqual([
      "called",
      "emailed",
    ]);
    expect(byCategory.navigation!.events.map((e) => e.raw)).toEqual([
      "work: Northwind",
    ]);
    expect(byCategory.content_interest!.total).toBe(128);
  });

  it("sorts within a category by count", () => {
    const groups = categoriseEvents(rows);
    const content = groups.find((g) => g.category === "content_interest")!;
    expect(content.events.map((e) => e.count)).toEqual([88, 40]);
  });

  it("omits empty categories rather than showing zeros", () => {
    // "No calls this month" and "we never tagged the call button" look
    // identical as a zero and mean opposite things.
    const groups = categoriseEvents([{ label: "photo: One", value: 1 }]);
    expect(groups.map((g) => g.category)).toEqual(["content_interest"]);
  });

  it("returns nothing at all for an empty input", () => {
    expect(categoriseEvents([])).toEqual([]);
  });

  it("surfaces unmapped events for operators but not for clients", () => {
    const groups = categoriseEvents(rows);
    const other = groups.find((g) => g.category === "other")!;
    expect(other.events.map((e) => e.raw)).toEqual(["newsletter signup"]);
    expect(CATEGORIES.other.clientVisible).toBe(false);
  });
});

describe("category wording", () => {
  it("never promises an outcome a click cannot prove", () => {
    expect(CATEGORIES.contact_intent.description).toMatch(/counts the tap/i);
    expect(CATEGORIES.confirmed_inquiry.description).toMatch(/actually arrived/i);
  });

  it("marks only `other` as operator-only", () => {
    const hidden = Object.values(CATEGORIES).filter((c) => !c.clientVisible);
    expect(hidden.map((c) => c.id)).toEqual(["other"]);
  });
});
