import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db/client";
import {
  beginStripeCheckout,
  createBillingPortalSession,
} from "@/db/repositories/client/stripe-checkout";
import { getStripeBillingPanel } from "@/db/repositories/client/stripe-billing";
import { stripeConfigured, stripeClient } from "@/lib/payments/stripe";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The portal with no Stripe credentials.
 *
 * This is not a hypothetical edge case: it is the state production is in the
 * moment this ships, and it may stay that way for a while. Square and manual
 * invoicing are still how most clients pay, so the billing page has to keep
 * working with `STRIPE_SECRET_KEY` unset.
 *
 * Two failures would be worse than the feature not existing:
 *
 *  - the billing page 500s, taking away the Square path that does work
 *  - something enrols a client, or looks like it did, with no processor behind
 *    it
 *
 * So: the panel is absent, every entry point refuses in words a client can
 * read, and nothing writes.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
});

afterAll(async () => {
  await close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function withoutStripe() {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
}

describe("billing with no Stripe credentials", () => {
  it("reports itself unconfigured rather than half-configured", () => {
    withoutStripe();

    expect(stripeConfigured()).toBe(false);
    // Null, not a throw. Absence is a supported state, and a constructor that
    // threw here would take out every page that merely imports this module.
    expect(stripeClient()).toBeNull();
  });

  it("hides the card panel instead of failing the billing page", async () => {
    withoutStripe();

    const panel = await getStripeBillingPanel(db, acme.ctx);

    // `available: false` is what the page branches on. The rest of the object
    // still has to be well formed, because the page reads it either way.
    expect(panel.available).toBe(false);
    expect(panel).toHaveProperty("status");
    expect(panel.history).toEqual([]);
  });

  it("refuses to start a checkout, in words a client can read", async () => {
    withoutStripe();

    const outcome = await beginStripeCheckout(db, acme.ctx, {
      planKey: "care-lite",
      successUrl: "https://portal.example.test/dashboard/billing?ok=1",
      cancelUrl: "https://portal.example.test/dashboard/billing",
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("not_configured");
      expect(outcome.message).toMatch(/not set up/i);
    }
  });

  it("refuses the billing portal too, rather than sending them nowhere", async () => {
    withoutStripe();

    const outcome = await createBillingPortalSession(
      db,
      acme.ctx,
      "https://portal.example.test/dashboard/billing",
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/not set up/i);
  });

  it("enrols nobody: a refused checkout leaves no Stripe customer behind", async () => {
    withoutStripe();

    await beginStripeCheckout(db, acme.ctx, {
      planKey: "care-lite",
      successUrl: "https://portal.example.test/ok",
      cancelUrl: "https://portal.example.test/no",
    });

    // The guard is the first statement in the function, before any write. A
    // client id minted here would be a customer with no subscription and no
    // way to reach it.
    const panel = await getStripeBillingPanel(db, acme.ctx);
    expect(panel.available).toBe(false);
    expect(panel.canManage).toBe(false);
  });
});
