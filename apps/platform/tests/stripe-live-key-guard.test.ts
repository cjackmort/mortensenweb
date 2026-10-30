import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A live Stripe key must only ever charge from the production deploy.
 *
 * Nothing used to stop a deploy preview, a branch deploy or a laptop holding a
 * live key from creating real Checkout Sessions, so the guard lives in the
 * module that hands out the client. Every test loads a fresh copy of it,
 * because the guard reports a refusal once per process.
 */

const LIVE = "sk_live_0123456789abcdef";
const TEST = "sk_test_0123456789abcdef";

async function loadStripeModule() {
  vi.resetModules();
  return import("@/lib/payments/stripe");
}

function environment(vars: Record<string, string>) {
  for (const name of ["CONTEXT", "NODE_ENV", "STRIPE_SECRET_KEY", "STRIPE_ALLOW_LIVE_KEY"]) {
    vi.stubEnv(name, "");
  }
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
}

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  logged.mockRestore();
});

describe("live Stripe key outside production", () => {
  it.each(["deploy-preview", "branch-deploy", "dev"])("switches Stripe off in the %s context", async (context) => {
    environment({ CONTEXT: context, NODE_ENV: "production", STRIPE_SECRET_KEY: LIVE });
    const stripe = await loadStripeModule();

    expect(stripe.stripeClient()).toBeNull();
    expect(stripe.stripeConfigured()).toBe(false);
    expect(stripe.modeMatches(true)).toBe(false);
    expect(() => stripe.requireStripe()).toThrow(stripe.StripeNotConfigured);
  });

  it("refuses a restricted live key the same way", async () => {
    environment({ CONTEXT: "deploy-preview", STRIPE_SECRET_KEY: "rk_live_0123456789abcdef" });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(false);
  });

  it("refuses on a developer machine, where no deploy context is set", async () => {
    environment({ NODE_ENV: "development", STRIPE_SECRET_KEY: LIVE });
    const stripe = await loadStripeModule();

    expect(stripe.stripeClient()).toBeNull();
  });

  it("refuses a key it cannot recognise as a test key", async () => {
    environment({ CONTEXT: "deploy-preview", STRIPE_SECRET_KEY: "  sk_live_padded" });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(false);
  });

  it("says why in the log, once, without printing the key", async () => {
    environment({ CONTEXT: "deploy-preview", STRIPE_SECRET_KEY: LIVE });
    const stripe = await loadStripeModule();

    stripe.stripeConfigured();
    stripe.stripeClient();
    stripe.modeMatches(true);

    expect(logged).toHaveBeenCalledTimes(1);
    const message = String(logged.mock.calls[0]?.[0]);
    expect(message).toMatch(/live/i);
    expect(message).toContain("deploy-preview");
    expect(message).not.toContain(LIVE);
  });
});

describe("live Stripe key in production", () => {
  it("is used when Netlify says the context is production", async () => {
    environment({ CONTEXT: "production", NODE_ENV: "production", STRIPE_SECRET_KEY: LIVE });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(true);
    expect(stripe.stripeClient()).not.toBeNull();
    expect(stripe.modeMatches(true)).toBe(true);
    expect(logged).not.toHaveBeenCalled();
  });

  it("is used when the runtime does not expose a context but the build is a production one", async () => {
    environment({ NODE_ENV: "production", STRIPE_SECRET_KEY: LIVE });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(true);
  });
});

describe("test keys", () => {
  it.each(["production", "deploy-preview", "branch-deploy"])("work in the %s context", async (context) => {
    environment({ CONTEXT: context, STRIPE_SECRET_KEY: TEST });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(true);
    expect(stripe.stripeClient()).not.toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("the operator's escape hatch", () => {
  it("lets a script on the operator's machine use the live key when asked in so many words", async () => {
    environment({ NODE_ENV: "development", STRIPE_SECRET_KEY: LIVE, STRIPE_ALLOW_LIVE_KEY: "true" });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(true);
  });

  it("does not take a vague yes", async () => {
    environment({ CONTEXT: "deploy-preview", STRIPE_SECRET_KEY: LIVE, STRIPE_ALLOW_LIVE_KEY: "1" });
    const stripe = await loadStripeModule();

    expect(stripe.stripeConfigured()).toBe(false);
  });
});
