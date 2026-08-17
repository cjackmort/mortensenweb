import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HANDLED_SQUARE_EVENTS,
  parseSquareEvent,
  referenceFromNote,
  squareBaseUrl,
  isSquareConfigured,
} from "@/lib/payments/square";
import {
  squareSignatureFor,
  verifySquareSignature,
} from "@/lib/webhooks/signature";

/**
 * Square.
 *
 * Money arriving is the one event in this platform that grants access, so the
 * failures worth testing are the ones where something is treated as a payment
 * when it is not:
 *
 *  - a notification whose signature was made for a different endpoint
 *  - an authorised-but-not-captured payment
 *  - a payment that matches no invoice, which must go to a human rather than be
 *    guessed at
 *
 * Also covered: the sandbox default, because an environment variable typo that
 * silently pointed at production would charge real cards.
 */

const KEY = "test-signature-key";
const URL = "https://portal.example.com/api/webhooks/square";

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {
    env: process.env.SQUARE_ENVIRONMENT,
    token: process.env.SQUARE_ACCESS_TOKEN,
    location: process.env.SQUARE_LOCATION_ID,
  };
});

afterEach(() => {
  for (const [k, name] of [
    ["env", "SQUARE_ENVIRONMENT"],
    ["token", "SQUARE_ACCESS_TOKEN"],
    ["location", "SQUARE_LOCATION_ID"],
  ] as const) {
    if (saved[k] === undefined) delete process.env[name];
    else process.env[name] = saved[k]!;
  }
});

describe("environment", () => {
  it("defaults to sandbox", () => {
    delete process.env.SQUARE_ENVIRONMENT;
    // The default that matters: an unset value must not charge real cards.
    expect(squareBaseUrl()).toContain("squareupsandbox.com");
  });

  it("only reaches production when asked exactly", () => {
    process.env.SQUARE_ENVIRONMENT = "production";
    expect(squareBaseUrl()).toBe("https://connect.squareup.com");

    for (const near of ["Production", "PROD", "prod", "live", "1"]) {
      process.env.SQUARE_ENVIRONMENT = near;
      expect(squareBaseUrl()).toContain("squareupsandbox.com");
    }
  });

  it("reports itself unconfigured rather than half-working", () => {
    delete process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_LOCATION_ID;
    expect(isSquareConfigured()).toBe(false);

    process.env.SQUARE_ACCESS_TOKEN = "tok";
    // A token without a location cannot take a payment; both or neither.
    expect(isSquareConfigured()).toBe(false);

    process.env.SQUARE_LOCATION_ID = "L1";
    expect(isSquareConfigured()).toBe(true);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ type: "payment.created", event_id: "e1" });

  it("accepts a correctly signed notification", async () => {
    const signature = await squareSignatureFor(body, KEY, URL);
    expect(await verifySquareSignature(body, signature, KEY, URL)).toBe(true);
  });

  it("rejects one signed for a different endpoint", async () => {
    // Square signs the notification URL together with the body precisely so a
    // capture from one endpoint cannot be replayed against another.
    const signature = await squareSignatureFor(body, KEY, URL);
    expect(
      await verifySquareSignature(
        body,
        signature,
        KEY,
        "https://portal.example.com/api/webhooks/square/",
      ),
    ).toBe(false);
  });

  it("rejects a body altered after signing", async () => {
    const signature = await squareSignatureFor(body, KEY, URL);
    const tampered = JSON.stringify({
      type: "payment.created",
      event_id: "e1",
      extra: true,
    });
    expect(await verifySquareSignature(tampered, signature, KEY, URL)).toBe(false);
  });

  it("rejects a missing or malformed header", async () => {
    expect(await verifySquareSignature(body, null, KEY, URL)).toBe(false);
    expect(await verifySquareSignature(body, "!!!not base64!!!", KEY, URL)).toBe(false);
  });
});

describe("event parsing", () => {
  const payment = (overrides: Record<string, unknown> = {}) => ({
    event_id: "evt_1",
    type: "payment.updated",
    data: {
      object: {
        payment: {
          id: "pay_1",
          order_id: "ord_1",
          status: "COMPLETED",
          note: "MW-7F3K — website services",
          amount_money: { amount: 9900, currency: "USD" },
          ...overrides,
        },
      },
    },
  });

  it("pulls out the fields the receiver acts on", () => {
    const event = parseSquareEvent(payment());
    expect(event).not.toBeNull();
    expect(event?.paymentId).toBe("pay_1");
    expect(event?.status).toBe("COMPLETED");
    expect(event?.amountCents).toBe(9900);
    expect(event?.note).toContain("MW-7F3K");
  });

  it("returns null for anything that is not an event", () => {
    for (const junk of [null, undefined, "string", 42, {}, { type: "x" }]) {
      expect(parseSquareEvent(junk)).toBeNull();
    }
  });

  it("survives a payload missing the fields it expects", () => {
    const event = parseSquareEvent({ event_id: "e", type: "payment.created" });
    expect(event).not.toBeNull();
    expect(event?.paymentId).toBeUndefined();
    expect(event?.amountCents).toBeUndefined();
  });

  it("handles only the events the receiver knows", () => {
    expect(HANDLED_SQUARE_EVENTS.has("payment.updated")).toBe(true);
    expect(HANDLED_SQUARE_EVENTS.has("subscription.created")).toBe(true);
    // An allowlist, so an event type added by Square later is ignored rather
    // than falling into a handler that was never written for it.
    expect(HANDLED_SQUARE_EVENTS.has("refund.created")).toBe(false);
    expect(HANDLED_SQUARE_EVENTS.has("customer.deleted")).toBe(false);
  });
});

describe("matching a payment to an invoice", () => {
  it("finds the reference inside a longer note", () => {
    expect(referenceFromNote("MW-7F3K — website services")).toBe("MW-7F3K");
    expect(referenceFromNote("paid MW-7F3K thanks!")).toBe("MW-7F3K");
  });

  it("normalises case", () => {
    expect(referenceFromNote("mw-7f3k")).toBe("MW-7F3K");
  });

  it("refuses to guess at an unlabelled payment", () => {
    // Guessing which invoice an unlabelled payment settles is how one client
    // gets credited for another's money — an error close to undetectable.
    expect(referenceFromNote("thanks")).toBeNull();
    expect(referenceFromNote("")).toBeNull();
    expect(referenceFromNote(undefined)).toBeNull();
  });

  it("does not match codes using letters the alphabet excludes", () => {
    // I, L, O and U are omitted so a code read aloud is unambiguous; a string
    // containing them is not a reference we ever issued.
    expect(referenceFromNote("MW-ILOU")).toBeNull();
  });
});
