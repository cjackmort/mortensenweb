import { describe, expect, it } from "vitest";
import { CLIENT_PROFILE_FIELDS } from "@/lib/business-profile";
import { MISSING_FIX, MISSING_MESSAGE, sendingReadiness, sendTimeFor, winbackSenderAddress } from "@/lib/winback/readiness";

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

describe("what to do about a gap", () => {
  it("sends the client straight to the profile field that fixes it", () => {
    expect(MISSING_FIX.postal_address).toEqual({ href: "/dashboard/profile?field=address", label: "Add your address" });
    // Replies go to the profile's public email when it has one.
    expect(MISSING_FIX.reply_to).toEqual({ href: "/dashboard/profile?field=email", label: "Add a business email" });
  });

  it("only links to a field the client can edit themselves", () => {
    const editable = new Set(CLIENT_PROFILE_FIELDS.map((f) => f.key));
    for (const fix of Object.values(MISSING_FIX)) {
      const field = new URL(fix.href, "https://portal.example").searchParams.get("field");
      expect(editable.has(field ?? "")).toBe(true);
    }
  });

  it("no longer asks for a request to fix what the client can fix", () => {
    expect(MISSING_MESSAGE.postal_address).not.toMatch(/request/i);
    expect(MISSING_MESSAGE.reply_to).not.toMatch(/request/i);
  });

  it("has nothing to link for what only we can switch on", () => {
    expect(MISSING_FIX.sender).toBeUndefined();
    expect(MISSING_FIX.links).toBeUndefined();
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
