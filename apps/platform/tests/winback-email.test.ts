import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWinbackEmail,
  firstNameFor,
  validateCampaignText,
  type WinbackEmailInput,
} from "@/lib/winback/email";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/winback/unsubscribe-token";

/**
 * The win-back email as a customer receives it.
 *
 * What would go wrong quietly: an email without the business's postal address
 * or a working unsubscribe — both required by CAN-SPAM, and both the kind of
 * thing nobody notices until a complaint; a customer's name that breaks the
 * HTML; and a business name able to rewrite the From header.
 */

const input: WinbackEmailInput = {
  campaign: {
    subject: "Is your furnace ready?",
    body: "Hi {first_name},\n\nCold weather is on the way.\n\nBook at https://peak.example/book.\n\nThanks again,\nPeak Heating",
    offer: "$20 off a tune-up",
    offerExpiresOn: "2026-11-30",
    fromName: "Peak Heating & Air",
    replyTo: "office@peak.example",
    postalAddress: "123 Main St\nRiverton, UT 84065",
  },
  recipient: { publicId: "01HRECIPIENT0000000000000A", email: "dana@example.test", name: "Dana Reyes" },
  senderAddress: "hello@mortensenweb.example",
  unsubscribeUrl: "https://portal.example/unsubscribe/tok",
  oneClickUrl: "https://portal.example/api/unsubscribe/tok",
};

describe("buildWinbackEmail", () => {
  it("comes from our address under the business's name, and replies go to the business", () => {
    const message = buildWinbackEmail(input);
    expect(message.from).toBe('"Peak Heating & Air" <hello@mortensenweb.example>');
    expect(message.replyTo).toBe("office@peak.example");
    expect(message.to).toBe("dana@example.test");
    expect(message.subject).toBe("Is your furnace ready?");
  });

  it("greets the customer by first name", () => {
    expect(buildWinbackEmail(input).text.startsWith("Hi Dana,")).toBe(true);
    const nameless = buildWinbackEmail({ ...input, recipient: { ...input.recipient, name: null } });
    expect(nameless.text.startsWith("Hi there,")).toBe(true);
  });

  it("carries the postal address, says it is promotional, and links to unsubscribe", () => {
    const message = buildWinbackEmail(input);
    for (const part of [message.text, message.html]) {
      expect(part).toContain("123 Main St");
      expect(part).toContain("Riverton, UT 84065");
      expect(part).toMatch(/promotional email/i);
      expect(part).toContain("https://portal.example/unsubscribe/tok");
    }
  });

  it("offers one-click unsubscribe in the headers", () => {
    const message = buildWinbackEmail(input);
    expect(message.headers).toEqual({
      "List-Unsubscribe": "<https://portal.example/api/unsubscribe/tok>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("is idempotent per recipient and tagged so webhooks can find it", () => {
    const message = buildWinbackEmail(input);
    expect(message.idempotencyKey).toBe("winback-01HRECIPIENT0000000000000A");
    expect(message.tags).toEqual([{ name: "winback_recipient", value: "01HRECIPIENT0000000000000A" }]);
  });

  it("shows the offer and when it ends", () => {
    const message = buildWinbackEmail(input);
    expect(message.text).toContain("$20 off a tune-up");
    expect(message.text).toContain("Nov 30, 2026");
    const noOffer = buildWinbackEmail({ ...input, campaign: { ...input.campaign, offer: null } });
    expect(noOffer.text).not.toMatch(/offer/i);
  });

  it("escapes what the client and the customer typed", () => {
    const message = buildWinbackEmail({
      ...input,
      campaign: { ...input.campaign, body: "Hi {first_name}, <script>x</script>" },
      recipient: { ...input.recipient, name: "<b>Dana</b>" },
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<b>Dana");
  });

  it("makes web addresses in the body into links", () => {
    expect(buildWinbackEmail(input).html).toContain('<a href="https://peak.example/book"');
  });

  it("keeps a business name from breaking out of the From header", () => {
    const message = buildWinbackEmail({
      ...input,
      campaign: { ...input.campaign, fromName: 'Evil" <x@evil.example>\r\nBcc: y@evil.example' },
    });
    expect(message.from).not.toMatch(/[\r\n]/);
    expect(message.from).toMatch(/<hello@mortensenweb\.example>$/);
    expect(message.from!.match(/</g)).toHaveLength(1);
  });
});

describe("firstNameFor", () => {
  it("uses the first word of a real name only", () => {
    expect(firstNameFor("Dana Reyes")).toBe("Dana");
    expect(firstNameFor("  sam  ")).toBe("sam");
    expect(firstNameFor("dana@example.test")).toBe("there");
    expect(firstNameFor("ACME LLC 2")).toBe("there");
    expect(firstNameFor(null)).toBe("there");
  });
});

describe("validateCampaignText", () => {
  const ok = { name: "Fall", subject: "Hello", body: "Hi {first_name}", offer: "", offerExpiresOn: "" };

  it("accepts a plain campaign", () => {
    expect(validateCampaignText(ok, new Date("2026-10-20T12:00:00Z"))).toEqual({ ok: true, value: { name: "Fall", subject: "Hello", body: "Hi {first_name}", offer: null, offerExpiresOn: null } });
  });

  it("needs a subject and a body", () => {
    const result = validateCampaignText({ ...ok, subject: " ", body: "" }, new Date());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["body", "subject"]);
  });

  it("refuses an offer that has already ended", () => {
    const result = validateCampaignText({ ...ok, offer: "10% off", offerExpiresOn: "2026-10-01" }, new Date("2026-10-20T12:00:00Z"));
    expect(result.ok).toBe(false);
  });

  it("drops an end date when there is no offer to end", () => {
    const result = validateCampaignText({ ...ok, offerExpiresOn: "2026-12-01" }, new Date("2026-10-20T12:00:00Z"));
    expect(result.ok && result.value.offerExpiresOn).toBeNull();
  });
});

describe("unsubscribe tokens", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  });

  it("round-trips the recipient it was minted for", async () => {
    const token = await signUnsubscribeToken("01HRECIPIENT0000000000000A");
    expect(await verifyUnsubscribeToken(token!)).toBe("01HRECIPIENT0000000000000A");
  });

  it("refuses a token for another recipient or a tampered one", async () => {
    const token = (await signUnsubscribeToken("01HRECIPIENT0000000000000A"))!;
    const [, sig] = token.split(".");
    expect(await verifyUnsubscribeToken(`01HRECIPIENT0000000000000B.${sig}`)).toBeNull();
    expect(await verifyUnsubscribeToken(`${token}x`)).toBeNull();
    expect(await verifyUnsubscribeToken("garbage")).toBeNull();
  });

  it("is not minted without a secret", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(await signUnsubscribeToken("01HRECIPIENT0000000000000A")).toBeNull();
  });
});
