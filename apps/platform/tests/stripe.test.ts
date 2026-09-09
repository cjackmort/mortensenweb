import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectedCents,
  expectedCentsForPlan,
  lookupKeyForPlan,
  modeFromKey,
  modeMatches,
  planForLookupKey,
  portalStatusFor,
  subscriptionIdFromInvoice,
} from "@/lib/payments/stripe";
import { billingStatusFor } from "@/lib/billing/stripe-status";
import { PLANS } from "@mortensenweb/plans";

/**
 * Stripe.
 *
 * As with Square, the failures worth testing are the ones where something is
 * treated as a payment when it is not, or where a client is told they are paid
 * when nobody has charged them. Specifically:
 *
 *  - a live event reaching a test-keyed deployment (or the reverse)
 *  - an invoice that settled without collecting any cash
 *  - an active subscription whose first invoice has not settled
 *  - a complimentary client being described in payment terms at all
 *  - the invoice→subscription field having moved in recent API versions
 */

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedKey;
});

describe("mode detection", () => {
  it("reads test mode from the key itself", () => {
    expect(modeFromKey("sk_test_abc123").livemode).toBe(false);
    expect(modeFromKey("rk_test_abc123").livemode).toBe(false);
  });

  it("treats anything that is not a test key as live", () => {
    // The safe direction to be wrong in: an unrecognised key shape is assumed
    // live, so it fails a livemode check against test events rather than
    // silently processing real money as though it were a sandbox.
    expect(modeFromKey("sk_live_abc123").livemode).toBe(true);
    expect(modeFromKey("garbage").livemode).toBe(true);
  });

  it("refuses a live event on a test key", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    expect(modeMatches(true)).toBe(false);
    expect(modeMatches(false)).toBe(true);
  });

  it("refuses a test event on a live key", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_abc";
    expect(modeMatches(false)).toBe(false);
    expect(modeMatches(true)).toBe(true);
  });

  it("matches nothing when Stripe is not configured", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(modeMatches(true)).toBe(false);
    expect(modeMatches(false)).toBe(false);
  });
});

describe("plan to price mapping", () => {
  it("maps every sellable plan to a lookup key", () => {
    for (const plan of PLANS) {
      expect(lookupKeyForPlan(plan.key), plan.key).toBeTruthy();
    }
  });

  it("round-trips", () => {
    for (const plan of PLANS) {
      const key = lookupKeyForPlan(plan.key)!;
      expect(planForLookupKey(key)).toBe(plan.key);
    }
  });

  it("has no price for a plan that is not sold", () => {
    // comp-unlimited must never be purchasable. A price on it is a route for a
    // complimentary client to be put through checkout.
    expect(planForLookupKey("comp_unlimited_monthly_v1")).toBeNull();
  });

  it("agrees with the published prices", () => {
    // Guards the drift this package was created to stop: the site quoting one
    // number while the portal bills another.
    expect(expectedCentsForPlan("care-lite")).toBe(5000);
    expect(expectedCentsForPlan("care-basic")).toBe(10000);
    expect(expectedCentsForPlan("care-plus")).toBe(20000);
    expect(expectedCentsForPlan("care-unlimited")).toBe(30000);
  });
});

describe("settlement is not cash", () => {
  it("reports what was actually collected, not the invoice total", () => {
    // A $100 invoice fully covered by credit settled, but no money arrived.
    // Reporting `total` here would overstate revenue.
    const invoice = { amount_paid: 0, total: 10000 } as never;
    expect(collectedCents(invoice)).toBe(0);
  });

  it("reports a real collection", () => {
    const invoice = { amount_paid: 10000, total: 10000 } as never;
    expect(collectedCents(invoice)).toBe(10000);
  });

  it("treats a missing amount_paid as zero rather than as the total", () => {
    const invoice = { total: 10000 } as never;
    expect(collectedCents(invoice)).toBe(0);
  });
});

describe("invoice to subscription", () => {
  it("reads the current parent.subscription_details shape", () => {
    const invoice = {
      parent: { subscription_details: { subscription: "sub_new" } },
    } as never;
    expect(subscriptionIdFromInvoice(invoice)).toBe("sub_new");
  });

  it("falls back to the pre-2025 top-level field", () => {
    // A replayed old event, or an endpoint pinned to an older version.
    const invoice = { subscription: "sub_old" } as never;
    expect(subscriptionIdFromInvoice(invoice)).toBe("sub_old");
  });

  it("prefers the current shape when both are present", () => {
    const invoice = {
      parent: { subscription_details: { subscription: "sub_new" } },
      subscription: "sub_old",
    } as never;
    expect(subscriptionIdFromInvoice(invoice)).toBe("sub_new");
  });

  it("handles an expanded object rather than an id string", () => {
    const invoice = {
      parent: { subscription_details: { subscription: { id: "sub_exp" } } },
    } as never;
    expect(subscriptionIdFromInvoice(invoice)).toBe("sub_exp");
  });

  it("returns null for a one-off invoice", () => {
    expect(subscriptionIdFromInvoice({} as never)).toBeNull();
  });
});

describe("status mapping", () => {
  it("keeps a client who missed a payment on the books", () => {
    // past_due must not read as cancelled: the client still has a
    // subscription, and every revenue rollup would otherwise lose them the
    // moment a card expired.
    expect(portalStatusFor("past_due")).toBe("active");
    expect(portalStatusFor("unpaid")).toBe("active");
  });

  it("maps the ended states to cancelled", () => {
    expect(portalStatusFor("canceled")).toBe("cancelled");
    expect(portalStatusFor("incomplete_expired")).toBe("cancelled");
  });

  it("treats an unstarted subscription as paused, not active", () => {
    expect(portalStatusFor("incomplete")).toBe("paused");
  });
});

describe("what the client is told", () => {
  const base = {
    compPlanId: null,
    providerStatus: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    hasSettledInvoice: false,
  };

  it("never says paid just because there are no invoices", () => {
    // The headline failure this module exists to prevent.
    const status = billingStatusFor(base);
    expect(status.state).toBe("not_subscribed");
    expect(status.label).not.toMatch(/paid/i);
  });

  it("says processing, not paid, while the first invoice is in flight", () => {
    const status = billingStatusFor({
      ...base,
      providerStatus: "active",
      hasSettledInvoice: false,
    });
    expect(status.state).toBe("processing");
  });

  it("says paid only on the evidence of a settled invoice", () => {
    const status = billingStatusFor({
      ...base,
      providerStatus: "active",
      hasSettledInvoice: true,
    });
    expect(status.state).toBe("paid");
  });

  it("asks for action on a failed payment and keeps the site up", () => {
    const status = billingStatusFor({
      ...base,
      providerStatus: "past_due",
      hasSettledInvoice: true,
    });
    expect(status.state).toBe("action_required");
    expect(status.needsAction).toBe(true);
    expect(status.detail).toMatch(/stays online/i);
  });

  it("distinguishes a scheduled cancellation from a cancelled account", () => {
    const status = billingStatusFor({
      ...base,
      providerStatus: "active",
      hasSettledInvoice: true,
      cancelAtPeriodEnd: true,
    });
    expect(status.state).toBe("cancellation_scheduled");
    // They keep what they paid for; this must not read as "not subscribed".
    expect(status.state).not.toBe("not_subscribed");
  });

  it("describes a complimentary client as complimentary whatever Stripe says", () => {
    // A payment event must never be able to present a comp client as a payer.
    const status = billingStatusFor({
      ...base,
      compPlanId: "plan-uuid",
      providerStatus: "past_due",
    });
    expect(status.state).toBe("complimentary");
    expect(status.needsAction).toBe(false);
  });

  it("does not optimistically report an unrecognised status as paid", () => {
    const status = billingStatusFor({
      ...base,
      providerStatus: "some_future_status",
      hasSettledInvoice: true,
    });
    expect(status.state).not.toBe("paid");
  });
});
