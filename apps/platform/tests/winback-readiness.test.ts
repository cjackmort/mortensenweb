import { describe, expect, it } from "vitest";
import { sendingReadiness, sendTimeFor, winbackSenderAddress } from "@/lib/winback/readiness";

/**
 * What must be true before a win-back campaign may be approved or sent.
 *
 * What would go wrong quietly: a campaign going out without the postal
 * address the law requires; a "scheduled for the 3rd" email arriving at 3am,
 * or on the 2nd, because the date was read in UTC.
 */

const env = {
  RESEND_FROM_ADDRESS: '"Mortensen Web Co." <hello@mortensenweb.example>',
  AUTH_SECRET: "s",
  AUTH_URL: "https://portal.example",
};

describe("sendingReadiness", () => {
  it("is ready with an address, somewhere for replies, and sending configured", () => {
    const result = sendingReadiness({ details: { address: "123 Main St, Riverton, UT" }, fallbackReplyTo: "owner@example.test", env });
    expect(result).toEqual({ ready: true, missing: [], replyTo: "owner@example.test", postalAddress: "123 Main St, Riverton, UT" });
  });

  it("blocks sending without a postal address, and says so plainly", () => {
    const result = sendingReadiness({ details: {}, fallbackReplyTo: "owner@example.test", env });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(["postal_address"]);
  });

  it("prefers the business's public email for replies", () => {
    const result = sendingReadiness({
      details: { address: "123 Main St", email: "office@peak.example" },
      fallbackReplyTo: "owner@example.test",
      env,
    });
    expect(result.replyTo).toBe("office@peak.example");
  });

  it("blocks when this server cannot send or sign links", () => {
    const result = sendingReadiness({ details: { address: "123 Main St" }, fallbackReplyTo: "o@example.test", env: {} });
    expect(result.missing).toEqual(["sender", "links"]);
  });
});

describe("winbackSenderAddress", () => {
  it("uses its own address when set, else the portal's", () => {
    expect(winbackSenderAddress({ WINBACK_FROM_ADDRESS: "offers@mail.example", ...env })).toBe("offers@mail.example");
    expect(winbackSenderAddress(env)).toBe("hello@mortensenweb.example");
    expect(winbackSenderAddress({})).toBeNull();
  });
});

describe("sendTimeFor", () => {
  it("sends at 9am in the business's timezone on the chosen day", () => {
    // Denver is UTC-6 in October (daylight time) and UTC-7 in December.
    expect(sendTimeFor("2026-10-28", "America/Denver")!.toISOString()).toBe("2026-10-28T15:00:00.000Z");
    expect(sendTimeFor("2026-12-02", "America/Denver")!.toISOString()).toBe("2026-12-02T16:00:00.000Z");
  });

  it("is null for anything that is not a date", () => {
    expect(sendTimeFor("", "America/Denver")).toBeNull();
    expect(sendTimeFor("2026-02-31", "America/Denver")).toBeNull();
    expect(sendTimeFor("tomorrow", "America/Denver")).toBeNull();
  });
});
