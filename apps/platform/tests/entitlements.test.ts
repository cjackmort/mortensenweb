import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeAllowances,
  changeRequests,
  clients,
  organizations,
  servicePlans,
  subscriptions,
  users,
} from "@/db/schema";
import {
  tenantContextFrom,
  type SessionLike,
  type TenantContext,
} from "@/db/repositories/context";
import {
  consumeChange,
  getAllowance,
  getEntitlements,
  refundChange,
} from "@/db/repositories/client/entitlements";
import { unlockClientFeatures } from "@/db/repositories/admin/entitlements";
import { currentPeriod, periodLabel } from "@/lib/billing/period";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Entitlements and change allowances.
 *
 * The tests that earn their keep here are the ones about *money and access*
 * going wrong under concurrency or across tenants:
 *
 *  - two submissions racing for the last change must not both succeed, because
 *    that is a change delivered for free and a client who learns the counter
 *    can be beaten;
 *  - an unlock must not move its own timestamp on the second payment;
 *  - a plan without analytics must not gain analytics by paying;
 *  - one tenant's allowance must be invisible to another.
 *
 * The happy path is checked too, but it is not what these are for.
 */

let db: Database;
let close: () => Promise<void>;

interface Tenant {
  orgId: string;
  clientId: string;
  userId: string;
  ctx: TenantContext;
}

let basic: Tenant;
let other: Tenant;
let planBasicId: string;
let planLiteId: string;

function sessionFor(orgId: string, userId: string): SessionLike {
  return {
    userId,
    organizationId: orgId,
    role: "client",
    status: "active",
    sessionEpoch: 0,
  };
}

async function seedTenant(
  slug: string,
  email: string,
  planId: string | null,
): Promise<Tenant> {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: slug, slug, kind: "client" })
      .returning()
  )[0]!;

  const user = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email, role: "client", status: "active" })
      .returning()
  )[0]!;

  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id })
      .returning()
  )[0]!;

  if (planId) {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: client.id,
      planId,
      monthlyPriceCents: 9900,
      startedOn: "2026-01-01",
      status: "active",
    });
  }

  return {
    orgId: org.id,
    clientId: client.id,
    userId: user.id,
    ctx: tenantContextFrom(sessionFor(org.id, user.id), org.id),
  };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(changeRequests);
  await db.delete(changeAllowances);
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);
  await db.delete(servicePlans);

  const plans = await db
    .insert(servicePlans)
    .values([
      {
        key: "care-basic",
        name: "Care — Basic",
        defaultMonthlyCents: 9900,
        includedChangesPerMonth: 3,
        overagePerChangeCents: 3900,
        includesAnalytics: true,
      },
      {
        key: "care-lite",
        name: "Care — Lite",
        defaultMonthlyCents: 4900,
        includedChangesPerMonth: 1,
        overagePerChangeCents: 4900,
        includesAnalytics: false,
      },
    ])
    .returning();

  planBasicId = plans.find((p) => p.key === "care-basic")!.id;
  planLiteId = plans.find((p) => p.key === "care-lite")!.id;

  basic = await seedTenant("acme", "acme@example.test", planBasicId);
  other = await seedTenant("globex", "globex@example.test", planBasicId);
});

describe("billing periods", () => {
  it("uses the business calendar month, not the UTC one", () => {
    // 1 September 2026, 02:00 UTC is still 31 August in Denver. A UTC-based
    // period would roll the allowance over while a client was still using it.
    const period = currentPeriod(new Date("2026-09-01T02:00:00Z"));
    expect(period.start).toBe("2026-08-01");
    expect(period.end).toBe("2026-08-31");
  });

  it("handles February in a leap year", () => {
    const period = currentPeriod(new Date("2028-02-15T12:00:00Z"));
    expect(period.start).toBe("2028-02-01");
    expect(period.end).toBe("2028-02-29");
  });

  it("handles a 30-day month", () => {
    const period = currentPeriod(new Date("2026-04-10T12:00:00Z"));
    expect(period.end).toBe("2026-04-30");
  });

  it("labels a period readably", () => {
    expect(periodLabel({ start: "2026-08-01", end: "2026-08-31" })).toBe(
      "August 2026",
    );
  });
});

describe("feature unlocking", () => {
  it("starts locked", async () => {
    const entitlements = await getEntitlements(db, basic.ctx);
    expect(entitlements?.analyticsUnlocked).toBe(false);
    expect(entitlements?.changeRequestsUnlocked).toBe(false);
  });

  it("unlocks analytics and change requests together", async () => {
    const outcome = await unlockClientFeatures(db, basic.clientId, {
      reason: "payment_confirmed",
    });
    expect(outcome.changed).toBe(true);

    const entitlements = await getEntitlements(db, basic.ctx);
    expect(entitlements?.analyticsUnlocked).toBe(true);
    expect(entitlements?.changeRequestsUnlocked).toBe(true);
  });

  it("does not move the unlock date on a second payment", async () => {
    await unlockClientFeatures(db, basic.clientId, { reason: "first" });

    const first = (
      await db
        .select({ at: clients.changeRequestsUnlockedAt })
        .from(clients)
        .where(eq(clients.id, basic.clientId))
    )[0]!.at;

    const second = await unlockClientFeatures(db, basic.clientId, {
      reason: "second",
    });
    expect(second.changed).toBe(false);

    const after = (
      await db
        .select({ at: clients.changeRequestsUnlockedAt })
        .from(clients)
        .where(eq(clients.id, basic.clientId))
    )[0]!.at;

    // "When did access begin" must answer the beginning, not the last renewal.
    expect(after?.getTime()).toBe(first?.getTime());
  });

  it("withholds analytics from a plan that does not include it", async () => {
    const lite = await seedTenant("initech", "initech@example.test", planLiteId);

    await unlockClientFeatures(db, lite.clientId, { reason: "payment_confirmed" });

    const entitlements = await getEntitlements(db, lite.ctx);
    // Paying for hosting buys hosting. Handing over analytics anyway would
    // remove the reason to ever upgrade.
    expect(entitlements?.analyticsUnlocked).toBe(false);
    expect(entitlements?.changeRequestsUnlocked).toBe(true);
  });
});

describe("change allowance", () => {
  it("reports the plan's allowance before anything is used", async () => {
    const allowance = await getAllowance(db, basic.ctx);
    expect(allowance?.included).toBe(3);
    expect(allowance?.used).toBe(0);
    expect(allowance?.remaining).toBe(3);
  });

  it("reading the allowance does not consume it", async () => {
    await getAllowance(db, basic.ctx);
    await getAllowance(db, basic.ctx);

    const rows = await db.select().from(changeAllowances);
    // No row at all: a page load must never create or spend anything.
    expect(rows).toHaveLength(0);
  });

  it("counts down as changes are used", async () => {
    const first = await consumeChange(db, basic.ctx);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.remaining).toBe(2);

    const second = await consumeChange(db, basic.ctx);
    if (second.ok) expect(second.remaining).toBe(1);

    const state = await getAllowance(db, basic.ctx);
    expect(state?.used).toBe(2);
    expect(state?.remaining).toBe(1);
  });

  it("refuses once the allowance is spent, and says what it cost", async () => {
    await consumeChange(db, basic.ctx);
    await consumeChange(db, basic.ctx);
    await consumeChange(db, basic.ctx);

    const fourth = await consumeChange(db, basic.ctx);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok && fourth.reason === "exhausted") {
      expect(fourth.included).toBe(3);
      // The UI needs this to offer "pay for this one" rather than a dead end.
      expect(fourth.overagePerChangeCents).toBe(3900);
    }
  });

  it("does not let two concurrent submissions spend the same last change", async () => {
    await consumeChange(db, basic.ctx);
    await consumeChange(db, basic.ctx);

    // Two submissions arriving together with exactly one change left. A
    // read-then-write implementation lets both through; the single-statement
    // conditional upsert must let exactly one.
    const [a, b] = await Promise.all([
      consumeChange(db, basic.ctx),
      consumeChange(db, basic.ctx),
    ]);

    const granted = [a, b].filter((outcome) => outcome.ok);
    expect(granted).toHaveLength(1);

    const state = await getAllowance(db, basic.ctx);
    expect(state?.used).toBe(3);
  });

  it("hands a change back when the request it was claimed for fails", async () => {
    const claim = await consumeChange(db, basic.ctx);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await refundChange(db, claim.allowanceId);

    const state = await getAllowance(db, basic.ctx);
    expect(state?.used).toBe(0);
  });

  it("never refunds below zero", async () => {
    const claim = await consumeChange(db, basic.ctx);
    if (!claim.ok) return;

    await refundChange(db, claim.allowanceId);
    await refundChange(db, claim.allowanceId);
    await refundChange(db, claim.allowanceId);

    const state = await getAllowance(db, basic.ctx);
    expect(state?.used).toBe(0);
  });

  it("keeps one tenant's usage invisible to another", async () => {
    await consumeChange(db, basic.ctx);
    await consumeChange(db, basic.ctx);

    const theirs = await getAllowance(db, other.ctx);
    expect(theirs?.used).toBe(0);
    expect(theirs?.remaining).toBe(3);
  });

  it("keeps a spent allowance at its original size when the plan shrinks", async () => {
    await consumeChange(db, basic.ctx);
    await consumeChange(db, basic.ctx);
    await consumeChange(db, basic.ctx);

    // The client downgrades mid-month.
    await db
      .update(subscriptions)
      .set({ planId: planLiteId })
      .where(eq(subscriptions.clientId, basic.clientId));

    const state = await getAllowance(db, basic.ctx);
    // Three of three used, not three of one. Someone who used what they had
    // and then downgraded has not retroactively overspent.
    expect(state?.included).toBe(3);
    expect(state?.used).toBe(3);
    expect(state?.remaining).toBe(0);
  });

  it("allows unlimited plans to keep going while still counting", async () => {
    await db
      .update(servicePlans)
      .set({ includedChangesPerMonth: null })
      .where(eq(servicePlans.id, planBasicId));

    for (let i = 0; i < 5; i += 1) {
      const outcome = await consumeChange(db, basic.ctx);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.remaining).toBeNull();
    }

    const state = await getAllowance(db, basic.ctx);
    // `used < NULL` is NULL, not true — without the explicit IS NULL branch in
    // the upsert, an unlimited client would be refused on their second change.
    expect(state?.used).toBe(5);
    expect(state?.remaining).toBeNull();
  });

  it("opens a fresh allowance in a new month", async () => {
    const august = new Date("2026-08-15T12:00:00Z");
    const september = new Date("2026-09-15T12:00:00Z");

    await consumeChange(db, basic.ctx, august);
    await consumeChange(db, basic.ctx, august);
    await consumeChange(db, basic.ctx, august);
    expect((await consumeChange(db, basic.ctx, august)).ok).toBe(false);

    const fresh = await consumeChange(db, basic.ctx, september);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.remaining).toBe(2);

    // August's record is left intact rather than reset.
    const augustState = await getAllowance(db, basic.ctx, august);
    expect(augustState?.used).toBe(3);
  });
});

describe("comped plans", () => {
  /**
   * An operator granting a plan without payment.
   *
   * The case this exists for is a client who has not paid and is not going to
   * — family, a friend of the business, someone owed an apology. Before it,
   * the only route to a working account was a confirmed payment, which made
   * those clients unserviceable rather than free.
   */

  async function compWith(key: string | null) {
    const plan = key
      ? (
          await db
            .select({ id: servicePlans.id })
            .from(servicePlans)
            .where(eq(servicePlans.key, key))
            .limit(1)
        )[0]!
      : null;

    await db
      .update(clients)
      .set({ compPlanId: plan?.id ?? null })
      .where(eq(clients.id, basic.clientId));
  }

  it("unlocks without any payment at all", async () => {
    // The timestamps stay null throughout: nothing was paid, and requiring
    // them would mean an operator granting a comp and finding it did nothing.
    await db
      .update(clients)
      .set({ analyticsUnlockedAt: null, changeRequestsUnlockedAt: null })
      .where(eq(clients.id, basic.clientId));

    let ent = await getEntitlements(db, basic.ctx);
    expect(ent?.changeRequestsUnlocked).toBe(false);

    await compWith("care-basic");

    ent = await getEntitlements(db, basic.ctx);
    expect(ent?.changeRequestsUnlocked).toBe(true);
    expect(ent?.analyticsUnlocked).toBe(true);
    expect(ent?.comped).toBe(true);
  });

  it("takes its allowance from the comped plan, not the paid one", async () => {
    await db.insert(servicePlans).values({
      key: "unlimited-comp",
      name: "Unlimited",
      defaultMonthlyCents: 0,
      includedChangesPerMonth: null,
      overagePerChangeCents: null,
      includesAnalytics: true,
    });

    await compWith("unlimited-comp");

    const ent = await getEntitlements(db, basic.ctx);
    // Unlimited, from the comp — regardless of what their subscription says.
    expect(ent?.includedChangesPerMonth).toBeNull();

    const allowance = await getAllowance(db, basic.ctx);
    expect(allowance?.included).toBeNull();
  });

  it("offers no overage, because there is no bill to add to", async () => {
    await compWith("care-basic");
    const ent = await getEntitlements(db, basic.ctx);
    expect(ent?.overagePerChangeCents).toBeNull();
  });

  it("still reports the real price, so the ledger and the dashboard agree", async () => {
    const before = (await getEntitlements(db, basic.ctx))?.monthlyPriceCents;
    await compWith("care-basic");
    expect((await getEntitlements(db, basic.ctx))?.monthlyPriceCents).toBe(before);
  });

  it("returns to following payment when withdrawn", async () => {
    await db
      .update(clients)
      .set({ analyticsUnlockedAt: null, changeRequestsUnlockedAt: null })
      .where(eq(clients.id, basic.clientId));

    await compWith("care-basic");
    expect((await getEntitlements(db, basic.ctx))?.changeRequestsUnlocked).toBe(true);

    await compWith(null);
    const ent = await getEntitlements(db, basic.ctx);
    expect(ent?.changeRequestsUnlocked).toBe(false);
    expect(ent?.comped).toBe(false);
  });
});
