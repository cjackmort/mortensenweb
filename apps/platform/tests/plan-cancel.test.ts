import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { auditLog, clientAddOns, clients, servicePlans, subscriptions } from "@/db/schema";
import { AuthorizationError, tenantContextFrom } from "@/db/repositories/context";
import { hasFeature } from "@/lib/growth/access";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";
import { addPrice, addSubscription, fakeStripe, resetFakeStripe, type FakeSubscription } from "./helpers/fake-stripe";

/**
 * Cancelling from the Plan tab: one click, no dialog, and an Undo.
 *
 * The failures worth testing are the ones a client would call a dark
 * pattern or a billing error: a cancellation that takes away what they have
 * already paid for, one that keeps charging, an Undo that charges them again
 * for days they already paid, no record that they cancelled, and one client
 * cancelling something an operator granted.
 */

const sent: Array<{ to: string; subject: string; text: string }> = [];

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    sent.push(message);
    return { status: "sent", id: `email_${sent.length}` };
  },
}));

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  const { fakeStripe: fake } = await import("./helpers/fake-stripe");
  return {
    ...actual,
    stripeConfigured: () => true,
    requireStripe: () => fake.client as never,
    priceForAddOn: async (feature: string) =>
      (fake.state.prices.get(`addon_${feature.replace(/-/g, "_")}_monthly_v1`) ?? null) as never,
  };
});

const growth = {
  ...(await import("@/db/repositories/client/growth")),
  ...(await import("@/db/repositories/client/cancellation")),
};
const { syncStripeAddOns } = await import("@/db/repositories/admin/stripe-webhooks");

const DAY = 86_400_000;

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let sub: FakeSubscription;
let periodEnd: Date;

async function addOnRow() {
  const [row] = await db
    .select()
    .from(clientAddOns)
    .where(and(eq(clientAddOns.clientId, acme.clientId), eq(clientAddOns.featureKey, "reviews"), isNull(clientAddOns.endedAt)));
  return row;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  resetFakeStripe();
  sent.length = 0;
  addPrice("addon_reviews_monthly_v1", 3500, "prod_reviews");
  acme = await seedTenant(db, `Acme ${newPublicId()}`);
  await db.update(clients).set({ primaryContactName: "Dana" }).where(eq(clients.id, acme.clientId));

  periodEnd = new Date(Math.floor((Date.now() + 10 * DAY) / 1000) * 1000);
  sub = addSubscription({
    customer: `cus_${newPublicId()}`,
    items: [
      { lookupKey: "care_monthly_v2", unitAmount: 5000, product: "prod_care", periodEnd: periodEnd.getTime() / 1000 },
      { lookupKey: "addon_reviews_monthly_v1", unitAmount: 3500, product: "prod_reviews", periodEnd: periodEnd.getTime() / 1000 },
    ],
  });
  const [care] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, "care"));
  await db.insert(subscriptions).values({
    publicId: newPublicId(),
    clientId: acme.clientId,
    planId: care!.id,
    monthlyPriceCents: 5000,
    startedOn: "2026-10-01",
    provider: "stripe",
    providerSubscriptionId: sub.id,
    currentPeriodEnd: periodEnd,
  });
  await db.insert(clientAddOns).values({
    clientId: acme.clientId,
    featureKey: "reviews",
    source: "stripe",
    stripeSubscriptionItemId: sub.items.data[1]!.id,
    monthlyPriceCents: 3500,
  });
});

describe("cancelling the plan", () => {
  it("cancels at the end of the paid period in one call, and emails a confirmation", async () => {
    const result = await growth.setPlanCancellation(db, acme.ctx, true);

    expect(result).toMatchObject({ ok: true });
    expect(sub.cancel_at_period_end).toBe(true);
    const state = await growth.getGrowthState(db, acme.ctx);
    expect(state.cancelsOn?.getTime()).toBe(periodEnd.getTime());
    expect(state.planKey).toBe("care");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: expect.stringContaining("@example.test"), subject: expect.stringMatching(/^Cancelled: Care plan/) });
    expect(sent[0]!.text).toMatch(/won't be charged for it again/);
    const audits = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.organizationId, acme.organizationId));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["growth.plan_cancel_scheduled", "growth.cancellation_emailed"]));
  });

  it("undoes it, without a second email", async () => {
    await growth.setPlanCancellation(db, acme.ctx, true);
    const result = await growth.setPlanCancellation(db, acme.ctx, false);

    expect(result.ok).toBe(true);
    expect(sub.cancel_at_period_end).toBe(false);
    expect((await growth.getGrowthState(db, acme.ctx)).cancelsOn).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("refuses while an operator is viewing as the client", async () => {
    const operator = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(growth.setPlanCancellation(db, operator, true)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(growth.cancelGrowthAddOn(db, operator, "reviews")).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("cancelling an add-on", () => {
  it("stops the charge at Stripe now, and keeps the feature until the paid period ends", async () => {
    const itemId = sub.items.data[1]!.id;

    const result = await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");

    expect(result).toMatchObject({ ok: true });
    expect(fakeStripe.state.calls).toContain("subscriptionItems.del");
    expect(sub.items.data.map((i) => i.id)).not.toContain(itemId);
    expect((await addOnRow())?.cancelsAt?.getTime()).toBe(periodEnd.getTime());
    const state = await growth.getGrowthState(db, acme.ctx);
    expect(hasFeature(state.access, "reviews")).toBe(true);
    expect(state.addOns.find((a) => a.featureKey === "reviews")?.cancelsAt?.getTime()).toBe(periodEnd.getTime());
    expect(sent[0]).toMatchObject({ subject: expect.stringMatching(/^Cancelled: Review requests/) });
  });

  it("takes the feature away once the paid period is over", async () => {
    await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");
    await db.update(clientAddOns).set({ cancelsAt: new Date(Date.now() - 1000) }).where(eq(clientAddOns.clientId, acme.clientId));

    const state = await growth.getGrowthState(db, acme.ctx);

    expect(hasFeature(state.access, "reviews")).toBe(false);
    expect(state.addOns.map((a) => a.featureKey)).not.toContain("reviews");
  });

  it("puts the line back on Undo without charging again for days already paid", async () => {
    await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");

    const result = await growth.undoAddOnCancellation(db, acme.ctx, "reviews");

    expect(result).toMatchObject({ ok: true });
    const readded = sub.items.data.find((i) => i.price.lookup_key === "addon_reviews_monthly_v1");
    expect(readded).toBeDefined();
    const row = await addOnRow();
    expect(row).toMatchObject({ cancelsAt: null, stripeSubscriptionItemId: readded!.id });
    expect(sent).toHaveLength(1);
  });

  it("re-adds with no proration, so Undo is not a new charge", async () => {
    const create = vi.spyOn(fakeStripe.client.subscriptionItems, "create");
    await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");
    await growth.undoAddOnCancellation(db, acme.ctx, "reviews");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ subscription: sub.id, price: "price_addon_reviews_monthly_v1", proration_behavior: "none" }),
    );
    create.mockRestore();
  });

  it("refuses Undo once the period it was paid for is over", async () => {
    await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");
    await db.update(clientAddOns).set({ cancelsAt: new Date(Date.now() - 1000) }).where(eq(clientAddOns.clientId, acme.clientId));

    const result = await growth.undoAddOnCancellation(db, acme.ctx, "reviews");

    expect(result).toMatchObject({ ok: false });
  });

  it("cancels the subscription at period end when the add-on is its only line", async () => {
    sub.items.data.splice(0, 1);

    const result = await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");

    expect(result.ok).toBe(true);
    expect(sub.cancel_at_period_end).toBe(true);
    expect(sub.items.data).toHaveLength(1);

    await growth.undoAddOnCancellation(db, acme.ctx, "reviews");
    expect(sub.cancel_at_period_end).toBe(false);
    expect((await addOnRow())?.cancelsAt).toBeNull();
  });

  it("never cancels one an operator granted", async () => {
    await db.delete(clientAddOns).where(eq(clientAddOns.clientId, acme.clientId));
    await db.insert(clientAddOns).values({ clientId: acme.clientId, featureKey: "reviews", source: "operator" });

    const result = await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");

    expect(result.ok).toBe(false);
    expect(fakeStripe.state.calls).toEqual([]);
  });

  it("is not ended early by the webhook that reports the line gone", async () => {
    await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");

    await syncStripeAddOns(db, acme.clientId, sub as unknown as Stripe.Subscription);

    expect((await addOnRow())?.cancelsAt?.getTime()).toBe(periodEnd.getTime());
  });

  it("can be bought again once it has lapsed", async () => {
    await growth.cancelGrowthAddOn(db, acme.ctx, "reviews");
    await db.update(clientAddOns).set({ cancelsAt: new Date(Date.now() - 1000) }).where(eq(clientAddOns.clientId, acme.clientId));

    // `reviews` is not built yet in every catalogue; the lapse sweep is what is under test.
    await growth.endLapsedAddOns(db, acme.clientId);

    expect(await addOnRow()).toBeUndefined();
  });
});
