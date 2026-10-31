import { describe, expect, it } from "vitest";
import { CHANGE_SIZES, FREE_SMALL_CHANGES_PER_MONTH } from "@mortensenweb/plans";
import { renderIssueBody } from "@/lib/github/issue";
import { dayLabel, freeTierRefusal, nextPeriodStart } from "@/lib/requests/free-tier";

/**
 * Decision D7's rule, before payment: small changes free, one a month; big
 * ones wait for the build or a plan. Pure — the action and the page both read
 * it — so the edges are pinned here.
 */

describe("the free tier's allowance", () => {
  it("is one small change a month, with examples the client can choose from", () => {
    expect(FREE_SMALL_CHANGES_PER_MONTH).toBe(1);
    expect(CHANGE_SIZES.map((s) => s.key)).toEqual(["small", "big"]);
    expect(CHANGE_SIZES[0]!.examples).toMatch(/prices/);
    expect(CHANGE_SIZES[1]!.examples).toMatch(/new page/);
  });
});

describe("freeTierRefusal", () => {
  const at = new Date("2026-10-15T18:00:00Z");

  it("takes the month's first small change", () => {
    expect(freeTierRefusal({ size: "small", used: 0, at })).toBeNull();
  });

  it("refuses a second small change in the same month, saying when the next opens", () => {
    expect(freeTierRefusal({ size: "small", used: 1, at })).toEqual({
      reason: "free_change_used",
      resetsOn: "2026-11-01",
      message: expect.stringContaining("November 1"),
    });
  });

  it("refuses a big change whatever is left, pointing at putting the site live", () => {
    const refusal = freeTierRefusal({ size: "big", used: 0, at });
    expect(refusal?.reason).toBe("needs_payment");
    expect(refusal?.message).toMatch(/putting your site live or a care plan/);
  });
});

describe("the business month", () => {
  it("rolls over at midnight in Denver, not in UTC", () => {
    // 05:30 UTC on 1 November is still 31 October in Denver.
    expect(nextPeriodStart(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
    expect(nextPeriodStart(new Date("2026-11-01T07:30:00Z"))).toBe("2026-12-01");
    expect(nextPeriodStart(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  it("names a day the way the page says it", () => {
    expect(dayLabel("2026-12-01")).toBe("December 1");
  });
});

describe("the issue the agent reads", () => {
  const base = {
    requestPublicId: "REQ",
    agentJobPublicId: "0123456789ABCDEFGHJKMNPQRS",
    title: "New page",
    description: "Add a page for our catering menu",
    category: "other",
    priority: "normal",
  };

  it("says the size, and tells the agent to hand a bigger change back before payment", () => {
    const body = renderIssueBody({ ...base, size: "small", smallOnly: true });
    expect(body).toContain("Size: small");
    expect(body).toContain("### Small changes only");
    expect(body).toContain("<!-- agent-escalation: bigger change");
  });

  it("only labels the size for a client on a plan", () => {
    const body = renderIssueBody({ ...base, size: "small", smallOnly: false });
    expect(body).toContain("Size: small");
    expect(body).not.toContain("Small changes only");
  });
});
