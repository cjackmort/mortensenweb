import { describe, expect, it } from "vitest";
import {
  summariseInquiries,
  type ConfirmedInquiry,
} from "@/lib/analytics/inquiries";
import { categoriseEvents, classifyEvent } from "@/lib/analytics/events";

/**
 * Confirmed enquiries.
 *
 * The only figure on the dashboard that claims an outcome rather than an
 * action, so the tests are mostly about what must *not* be able to produce it.
 */

function submission(
  id: string,
  state: ConfirmedInquiry["state"],
  isoDate: string,
  referrer: string | null = "google.com",
): ConfirmedInquiry {
  return {
    id,
    state,
    receivedAt: new Date(isoDate),
    formName: "contact",
    referrer,
  };
}

describe("nothing from the browser can become a confirmed enquiry", () => {
  it("keeps a submit-button click as intent", () => {
    // `enquiry sent` fires before validation and before the POST.
    expect(classifyEvent("enquiry sent", 12).category).toBe("contact_intent");
  });

  it("has no rule that could classify a /thanks/ pageview as an enquiry", () => {
    // The success page is directly reachable, a refresh counts twice, and a
    // bookmark inflates it on every visit. It is not evidence of delivery.
    for (const name of ["/thanks/", "thanks", "thank you", "form success"]) {
      expect(classifyEvent(name, 5).category, name).not.toBe("confirmed_inquiry");
    }
  });

  it("leaves the category empty when no backend outcomes are supplied", () => {
    const groups = categoriseEvents([
      { label: "enquiry sent", value: 9 },
      { label: "emailed", value: 4 },
      { label: "photo: One", value: 30 },
    ]);
    expect(groups.find((g) => g.category === "confirmed_inquiry")).toBeUndefined();
  });
});

describe("backend outcomes populate the category", () => {
  it("adds a confirmed count that no event produced", () => {
    const groups = categoriseEvents(
      [{ label: "enquiry sent", value: 9 }],
      [{ id: "netlify_form_accepted", label: "Contact form", count: 2 }],
    );

    const confirmed = groups.find((g) => g.category === "confirmed_inquiry");
    expect(confirmed?.total).toBe(2);
    // The click count is unchanged and still filed as intent — nine presses,
    // two messages, and the dashboard shows both rather than conflating them.
    expect(groups.find((g) => g.category === "contact_intent")?.total).toBe(9);
  });

  it("ignores a zero outcome rather than rendering an empty category", () => {
    const groups = categoriseEvents(
      [{ label: "photo: One", value: 1 }],
      [{ id: "netlify_form_accepted", label: "Contact form", count: 0 }],
    );
    expect(groups.find((g) => g.category === "confirmed_inquiry")).toBeUndefined();
  });
});

describe("summariseInquiries", () => {
  it("deduplicates by the provider's id", () => {
    // The provider is the only thing that knows whether two identical-looking
    // records are one person pressing send twice or two separate people.
    const summary = summariseInquiries([
      submission("a", "accepted", "2026-05-02T10:00:00Z"),
      submission("a", "accepted", "2026-05-02T10:00:00Z"),
      submission("b", "accepted", "2026-05-03T10:00:00Z"),
    ]);
    expect(summary.accepted).toBe(2);
  });

  it("counts spam separately and keeps it out of the headline", () => {
    // A site being hammered by bots must not look like a site doing well.
    const summary = summariseInquiries([
      submission("a", "accepted", "2026-05-02T10:00:00Z"),
      submission("s1", "spam", "2026-05-02T11:00:00Z"),
      submission("s2", "spam", "2026-05-02T12:00:00Z"),
    ]);
    expect(summary.accepted).toBe(1);
    expect(summary.spam).toBe(2);
  });

  it("counts a qualified lead as accepted too", () => {
    // Otherwise the accepted figure falls whenever an operator marks something
    // as a real lead, which would look like enquiries going down.
    const summary = summariseInquiries([
      submission("a", "accepted", "2026-05-02T10:00:00Z"),
      submission("b", "qualified", "2026-05-03T10:00:00Z"),
    ]);
    expect(summary.accepted).toBe(2);
    expect(summary.qualified).toBe(1);
  });

  it("never infers qualified from an accepted submission", () => {
    const summary = summariseInquiries([
      submission("a", "accepted", "2026-05-02T10:00:00Z"),
      submission("b", "accepted", "2026-05-03T10:00:00Z"),
    ]);
    // Whether a submission is a lead worth having is a human judgement nobody
    // has made at this point.
    expect(summary.qualified).toBe(0);
  });

  it("uses a half-open window so a boundary submission is not double counted", () => {
    const start = Date.parse("2026-05-01T00:00:00Z");
    const end = Date.parse("2026-05-08T00:00:00Z");

    const summary = summariseInquiries(
      [
        submission("before", "accepted", "2026-04-30T23:59:59Z"),
        submission("at-start", "accepted", "2026-05-01T00:00:00Z"),
        submission("at-end", "accepted", "2026-05-08T00:00:00Z"),
      ],
      { startAt: start, endAt: end },
    );

    // `at-end` belongs to the next period; counting it in both is how a
    // comparison against the previous window inflates one of them.
    expect(summary.accepted).toBe(1);
    expect(summary.recent.map((s) => s.id)).toEqual(["at-start"]);
  });

  it("preserves an unknown source rather than guessing one", () => {
    const summary = summariseInquiries([
      submission("a", "accepted", "2026-05-02T10:00:00Z", null),
      submission("b", "accepted", "2026-05-03T10:00:00Z", "google.com"),
    ]);
    // Attributing an enquiry to whichever campaign happened to be running is
    // how a channel gets credit it did not earn.
    expect(summary.unknownSource).toBe(1);
  });

  it("orders recent submissions newest first", () => {
    const summary = summariseInquiries([
      submission("old", "accepted", "2026-05-01T10:00:00Z"),
      submission("new", "accepted", "2026-05-09T10:00:00Z"),
    ]);
    expect(summary.recent.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("handles no submissions at all", () => {
    const summary = summariseInquiries([]);
    expect(summary).toMatchObject({ accepted: 0, spam: 0, qualified: 0, unknownSource: 0 });
    expect(summary.recent).toEqual([]);
  });
});
