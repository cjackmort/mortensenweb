import { afterEach, describe, expect, it, vi } from "vitest";
import { localStripeHost } from "@/lib/payments/stripe";

/**
 * The local Stripe stand-in used for previews (`scripts/fake-stripe.ts`).
 *
 * The one failure worth testing: a deployment talking to anything but Stripe
 * with a real key. The override must only ever apply to a test key, outside
 * production, pointed at this machine.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localStripeHost", () => {
  it("points a test key at a stand-in on localhost during development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_API_BASE", "http://localhost:12111");
    expect(localStripeHost("sk_test_abc")).toEqual({ host: "localhost", port: 12111, protocol: "http" });
  });

  it("never applies to a live key", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_API_BASE", "http://localhost:12111");
    expect(localStripeHost("sk_live_abc")).toBeNull();
    expect(localStripeHost("rk_live_abc")).toBeNull();
  });

  it("never applies in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRIPE_API_BASE", "http://localhost:12111");
    expect(localStripeHost("sk_test_abc")).toBeNull();
  });

  it("never points anywhere but this machine", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_API_BASE", "http://stripe.example.com:12111");
    expect(localStripeHost("sk_test_abc")).toBeNull();
  });

  it("is off unless asked for", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STRIPE_API_BASE", "");
    expect(localStripeHost("sk_test_abc")).toBeNull();
  });
});
