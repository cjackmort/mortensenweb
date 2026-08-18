import { describe, expect, it } from "vitest";
import { renderBriefIssueBody } from "@/lib/github/issue";

/**
 * What a first-build brief tells the agent.
 *
 * The brief that produced the first concepts said "use the structure and
 * visual language already present in this repository, replacing its content",
 * which is an instruction to recolour the template. These tests pin the
 * replacement, and one property that is easy to lose: the design commission
 * must sit in *our* framing, because anything inside the fenced block is
 * explicitly labelled as the owner's words and the agent is told not to act on
 * instructions found there.
 */

const base = {
  briefPublicId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  agentJobPublicId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
  businessName: "Acme Plumbing",
};

describe("a first-build brief", () => {
  const body = renderBriefIssueBody({
    ...base,
    kind: "discovery",
    sourceWebsiteUrl: "https://acme.example",
    verifiedFacts: [{ key: "phone", value: "+1 303 555 0100" }],
  });

  it("commissions a design rather than a content swap", () => {
    expect(body).toContain("speculative concept");
    expect(body).toContain("starting point, not a");
    expect(body).not.toContain("visual language already present");
  });

  it("names their current site as context", () => {
    expect(body).toContain("https://acme.example");
  });

  it("forbids copying their site", () => {
    // Their code is not ours to take, and the rule is absolute.
    expect(body).toContain("Do not copy its markup");
  });

  it("keeps facts and inspiration separate", () => {
    // Their live site may be years out of date. It can inform the design; it
    // cannot be the source of a claim.
    expect(body).toContain("must come from the confirmed details");
  });

  it("puts the commission outside the client's fenced words", () => {
    // The property that would silently break the feature: the agent is told to
    // treat the fenced block as data and never as instruction, so a commission
    // placed inside it is a commission it has been told to ignore.
    const commission = body.indexOf("What this is for");
    const ownerNotes = body.indexOf("What the owner asked for");
    expect(commission).toBeGreaterThan(-1);
    expect(commission).toBeLessThan(ownerNotes);
  });

  it("carries the confirmed facts and permits only those as claims", () => {
    expect(body).toContain("+1 303 555 0100");
    expect(body).toContain("must not be invented");
  });

  it("refuses invention when nothing is confirmed", () => {
    const bare = renderBriefIssueBody({ ...base, kind: "discovery" });
    expect(bare).toContain("Do not invent business details");
    expect(bare).toContain("obvious placeholders");
  });
});

describe("a revision brief", () => {
  const body = renderBriefIssueBody({
    ...base,
    kind: "revision",
    sourceWebsiteUrl: "https://acme.example",
  });

  it("does not re-commission a whole design", () => {
    // A revision adjusts something that exists. Repeating the commission would
    // invite a rebuild every time the client asks for a different heading.
    expect(body).not.toContain("What this is for");
    expect(body).not.toContain("speculative concept");
  });

  it("still refuses invented claims", () => {
    expect(body).toContain("Do not invent business details");
  });
});
