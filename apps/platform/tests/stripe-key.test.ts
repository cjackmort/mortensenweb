import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  acceptStripeKey,
  checkStripeKey,
  fetchStripeSnapshot,
  STRIPE_KEY_PERMISSIONS,
} from "@/lib/connections/providers/stripe";
import { ProviderError } from "@/lib/connections/types";

/**
 * Stripe by restricted key.
 *
 * Stripe only lets its old extensions ask for read-only access through
 * OAuth, so a client makes a restricted key that can only read and pastes
 * it. What would go wrong quietly: the full secret key accepted and stored;
 * a test key taken on the live portal and every month reading "nothing
 * paid"; a key missing a permission accepted, then failing every night; and
 * the key itself echoed into a message, a log line or `last_error`.
 */

/**
 * Made-up keys, assembled at run time so the source holds nothing shaped
 * like a real key for a secret scanner to stop at the push.
 */
function fakeKey(kind: "sk" | "rk" | "pk", mode: "live" | "test"): string {
  return [kind, mode, "51AbCdEfGhIjKlMnOpQrStUv"].join("_");
}

const LIVE_KEY = fakeKey("rk", "live");
const NOW = new Date("2026-10-29T12:00:00Z");
const WINDOW = { startAt: new Date("2026-09-29T12:00:00Z"), endAt: NOW };

type Call = { resource: string; opts: unknown };

function listOf<T>(resource: string, items: T[], calls: Call[]) {
  return (_params?: unknown, opts?: unknown) => {
    calls.push({ resource, opts });
    const page = Promise.resolve({ object: "list", data: items.slice(0, 1), has_more: items.length > 1 });
    return Object.assign(page, { autoPagingToArray: async () => items });
  };
}

function stripeError(type: string, statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { type, statusCode });
}

function permissionError(rak: string): Error {
  return stripeError(
    "StripePermissionError",
    403,
    `The provided key 'rk_live_*********************StUv' does not have the required permissions for this endpoint on account 'acct_1'. Having the '${rak}' permission would allow this request to continue.`,
  );
}

const ACCOUNT = {
  id: "acct_1",
  default_currency: "usd",
  charges_enabled: true,
  payouts_enabled: true,
  requirements: { currently_due: [], past_due: [] },
  settings: { payments: { statement_descriptor: "ACME PLUMBING" }, dashboard: { display_name: "Acme" } },
  business_profile: { name: "Acme Plumbing", url: "https://acmeplumbing.example", support_email: null, support_phone: null },
};

function fakeStripe(overrides: Record<string, unknown> = {}, calls: Call[] = []): Stripe {
  return {
    accounts: {
      retrieveCurrent: async (...args: unknown[]) => {
        calls.push({ resource: "account", opts: args });
        return ACCOUNT;
      },
    },
    charges: {
      list: listOf(
        "charges",
        [
          { amount: 12000, paid: true, status: "succeeded", currency: "usd" },
          { amount: 5000, paid: false, status: "failed", currency: "usd" },
        ],
        calls,
      ),
    },
    refunds: { list: listOf("refunds", [{ amount: 2000, status: "succeeded" }], calls) },
    disputes: { list: listOf("disputes", [], calls) },
    paymentIntents: {
      list: listOf(
        "paymentIntents",
        [
          { status: "succeeded", last_payment_error: null },
          { status: "requires_payment_method", last_payment_error: { code: "card_declined" } },
        ],
        calls,
      ),
    },
    ...overrides,
  } as unknown as Stripe;
}

describe("checking a pasted Stripe key", () => {
  it("takes a live restricted key, trimmed", () => {
    expect(checkStripeKey(`  ${LIVE_KEY}\n`, { production: true })).toEqual({ ok: true, key: LIVE_KEY });
  });

  it("refuses the secret key, which can do anything in the account", () => {
    const check = checkStripeKey(fakeKey("sk", "live"), { production: true });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.message).toContain("secret key");
  });

  it("refuses the publishable key, which cannot read anything", () => {
    const check = checkStripeKey(fakeKey("pk", "live"), { production: true });
    expect(!check.ok && check.message).toContain("publishable key");
  });

  it("refuses a test key on the live portal, and takes one in development", () => {
    const live = checkStripeKey(fakeKey("rk", "test"), { production: true });
    expect(!live.ok && live.message).toContain("test key");
    expect(checkStripeKey(fakeKey("rk", "test"), { production: false }).ok).toBe(true);
  });

  it("refuses anything that is not a Stripe key, and never repeats what was pasted", () => {
    for (const pasted of ["", "   ", "hello", "rk_live_", "rk_live_abc def", "acct_1"]) {
      const check = checkStripeKey(pasted, { production: true });
      expect(check.ok).toBe(false);
      // A bare prefix is what the message itself tells them to look for.
      if (!check.ok && pasted.trim().length > "rk_live_".length) expect(check.message).not.toContain(pasted.trim());
    }
  });
});

describe("accepting a Stripe key", () => {
  it("names the account and keeps the key as the token, after reading each thing the audit needs", async () => {
    const calls: Call[] = [];
    const grant = await acceptStripeKey(LIVE_KEY, { stripe: fakeStripe({}, calls) });
    expect(grant).toEqual({
      externalId: "acct_1",
      displayName: "Acme Plumbing",
      scope: "restricted_key",
      accessToken: LIVE_KEY,
      refreshToken: null,
      expiresAt: null,
    });
    expect(calls.map((c) => c.resource).sort()).toEqual(["account", "charges", "disputes", "paymentIntents", "refunds"]);
  });

  it("says a key Stripe does not know was not accepted", async () => {
    const stripe = fakeStripe({
      accounts: {
        retrieveCurrent: async () => {
          throw stripeError("StripeAuthenticationError", 401, `Invalid API Key provided: ${LIVE_KEY.slice(0, 12)}****StUv`);
        },
      },
    });
    const error = await acceptStripeKey(LIVE_KEY, { stripe }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("invalid");
    expect((error as ProviderError).message).toContain("didn't accept that key");
  });

  it("names each permission the key is missing once, as Stripe's form names it, without the key", async () => {
    const stripe = fakeStripe({
      charges: {
        list: () => {
          throw permissionError("rak_charge_read");
        },
      },
      refunds: {
        list: () => {
          throw permissionError("rak_refund_read");
        },
      },
      disputes: {
        list: () => {
          throw permissionError("rak_dispute_read");
        },
      },
    });
    const error = (await acceptStripeKey(LIVE_KEY, { stripe }).catch((e: unknown) => e)) as ProviderError;
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain("“Charges and Refunds” and “Payment Disputes”");
    expect(error.message.match(/Charges and Refunds/g)).toHaveLength(1);
    expect(error.message).not.toContain("Payment Intents");
    expect(error.message).not.toContain("Accounts");
    expect(error.message).not.toContain("StUv");
  });

  it("asks for exactly the four permissions on Stripe's form, filed where the form files them", () => {
    expect(STRIPE_KEY_PERMISSIONS).toEqual([
      { name: "Charges and Refunds", section: "Core" },
      { name: "Payment Disputes", section: "Core" },
      { name: "Payment Intents", section: "Core" },
      { name: "Accounts", section: "Connect" },
    ]);
  });

  it("treats Stripe being down as passing, not as a bad key, and strips a key Stripe echoed", async () => {
    const stripe = fakeStripe({
      accounts: {
        retrieveCurrent: async () => {
          throw stripeError("StripeAPIError", 500, `An unknown error occurred for ${LIVE_KEY}`);
        },
      },
    });
    const error = (await acceptStripeKey(LIVE_KEY, { stripe }).catch((e: unknown) => e)) as ProviderError;
    expect(error.kind).toBe("unavailable");
    expect(error.message).not.toContain(LIVE_KEY);
    expect(error.message).toContain("[key]");
  });
});

describe("reading a Stripe account by its key", () => {
  it("reads the key's own account, with no Stripe-Account header, and counts the month", async () => {
    const calls: Call[] = [];
    const snapshot = await fetchStripeSnapshot(WINDOW, { stripe: fakeStripe({}, calls) });
    expect(calls.filter((c) => c.resource !== "account").every((c) => c.opts === undefined)).toBe(true);
    expect(calls.find((c) => c.resource === "account")!.opts).toEqual([]);
    expect(snapshot).toMatchObject({
      accountId: "acct_1",
      statementDescriptor: "ACME PLUMBING",
      charges: { count: 1, grossCents: 12000 },
      refunds: { count: 1, cents: 2000 },
      disputes: { count: 0, cents: 0 },
      attempts: { succeeded: 1, failed: 1 },
    });
  });

  it("asks to reconnect when the key was deleted or lost a permission, and keeps the key out of the message", async () => {
    const deleted = fakeStripe({
      accounts: {
        retrieveCurrent: async () => {
          throw stripeError("StripeAuthenticationError", 401, "Invalid API Key provided: rk_live_*****StUv");
        },
      },
    });
    const gone = (await fetchStripeSnapshot(WINDOW, { stripe: deleted }).catch((e: unknown) => e)) as ProviderError;
    expect(gone.kind).toBe("auth");
    expect(gone.message).not.toMatch(/rk_live_\S/);

    const narrowed = fakeStripe({
      refunds: {
        list: () => {
          throw permissionError("rak_refund_read");
        },
      },
    });
    const lost = (await fetchStripeSnapshot(WINDOW, { stripe: narrowed }).catch((e: unknown) => e)) as ProviderError;
    expect(lost.kind).toBe("auth");
    expect(lost.message).toContain("“Charges and Refunds”");
    expect(lost.message).not.toMatch(/rk_live_\S/);
  });
});
