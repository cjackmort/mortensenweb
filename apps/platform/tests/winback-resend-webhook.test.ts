import { describe, expect, it } from "vitest";
import {
  parseResendEvent,
  svixSignatureFor,
  verifySvixSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from "@/lib/winback/resend-webhook";

/**
 * Resend's delivery webhooks, which Resend signs with Svix.
 *
 * What would go wrong quietly: an unsigned or replayed request suppressing a
 * client's customers or faking their open rate; and a signature check that
 * reads the secret as text rather than the base64 key it is, which rejects
 * every real delivery while every test that signs the same wrong way passes.
 */

// A real-shaped secret: `whsec_` and base64 of the key bytes.
const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const BODY = JSON.stringify({
  type: "email.opened",
  created_at: "2026-10-20T16:00:00.000Z",
  data: { email_id: "re_abc", to: ["dana@example.test"], tags: { winback_recipient: "01HRECIPIENT0000000000000A" } },
});
const NOW = new Date("2026-10-20T16:00:30Z");
const TS = String(Math.floor(new Date("2026-10-20T16:00:00Z").getTime() / 1000));

describe("verifySvixSignature", () => {
  it("accepts a delivery signed with the secret's key", async () => {
    const signature = await svixSignatureFor("msg_1", TS, BODY, SECRET);
    expect(await verifySvixSignature({ id: "msg_1", timestamp: TS, signature, body: BODY, secret: SECRET, now: NOW })).toBe(true);
  });

  it("agrees with Svix's own published example", async () => {
    // From Svix's verification docs: not signed by our own helper, so a key
    // read the wrong way cannot pass this.
    expect(
      await verifySvixSignature({
        id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
        timestamp: "1614265330",
        signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        body: '{"test": 2432232314}',
        secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        now: new Date(1614265330 * 1000),
      }),
    ).toBe(true);
  });

  it("accepts any of several signatures, as during a secret rotation", async () => {
    const good = await svixSignatureFor("msg_1", TS, BODY, SECRET);
    const signature = `v1,bm90IGl0 ${good}`;
    expect(await verifySvixSignature({ id: "msg_1", timestamp: TS, signature, body: BODY, secret: SECRET, now: NOW })).toBe(true);
  });

  it("refuses a changed body, a different id, or another secret", async () => {
    const signature = await svixSignatureFor("msg_1", TS, BODY, SECRET);
    const base = { id: "msg_1", timestamp: TS, signature, body: BODY, secret: SECRET, now: NOW };
    expect(await verifySvixSignature({ ...base, body: BODY.replace("opened", "complained") })).toBe(false);
    expect(await verifySvixSignature({ ...base, id: "msg_2" })).toBe(false);
    expect(await verifySvixSignature({ ...base, secret: `whsec_${btoa("another key, another key, 123456")}` })).toBe(false);
  });

  it("refuses a delivery outside the replay window", async () => {
    const signature = await svixSignatureFor("msg_1", TS, BODY, SECRET);
    const late = new Date(NOW.getTime() + (WEBHOOK_TOLERANCE_SECONDS + 60) * 1000);
    expect(await verifySvixSignature({ id: "msg_1", timestamp: TS, signature, body: BODY, secret: SECRET, now: late })).toBe(false);
  });

  it("refuses missing headers and an unset secret", async () => {
    const signature = await svixSignatureFor("msg_1", TS, BODY, SECRET);
    expect(await verifySvixSignature({ id: null, timestamp: TS, signature, body: BODY, secret: SECRET, now: NOW })).toBe(false);
    expect(await verifySvixSignature({ id: "msg_1", timestamp: TS, signature: null, body: BODY, secret: SECRET, now: NOW })).toBe(false);
    expect(await verifySvixSignature({ id: "msg_1", timestamp: TS, signature, body: BODY, secret: "", now: NOW })).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("reads the event, the email and the recipient tag", () => {
    expect(parseResendEvent(BODY)).toEqual({
      type: "opened",
      emailId: "re_abc",
      recipientPublicId: "01HRECIPIENT0000000000000A",
      at: new Date("2026-10-20T16:00:00.000Z"),
    });
  });

  it("reads tags sent as a list too", () => {
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-10-20T16:00:00.000Z",
      data: { email_id: "re_abc", tags: [{ name: "winback_recipient", value: "01HRECIPIENT0000000000000A" }] },
    });
    expect(parseResendEvent(body)?.recipientPublicId).toBe("01HRECIPIENT0000000000000A");
    expect(parseResendEvent(body)?.type).toBe("bounced");
  });

  it("ignores events it has no use for, and anything malformed", () => {
    expect(parseResendEvent(JSON.stringify({ type: "contact.created", data: {} }))).toBeNull();
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ type: "email.opened", data: {} }))).toBeNull();
  });
});
