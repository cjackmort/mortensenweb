import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeAllowances,
  clients,
  organizations,
  paymentRequests,
  payments,
  servicePlans,
  subscriptions,
  users,
} from "@/db/schema";
import {
  adminContextFrom,
  tenantContextFrom,
  type AdminContext,
  type SessionLike,
  type TenantContext,
} from "@/db/repositories/context";
import { confirmPaymentReceived, raisePaymentRequest } from "@/db/repositories/admin/billing";
import {
  getBillingOverview,
} from "@/db/repositories/client/billing";
import { getOrCreateExtraChangeRequest } from "@/db/repositories/client/checkout";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Buying one more change.
 *
 * This is the path that used to silently do nothing: `insertPaymentRequest`
 * accepted `purpose` and `coversPeriodStart`/`coversPeriodEnd` in its own
 * type signature and then never wrote them, so every extra-change purchase
 * landed as an ordinary "subscription" row with no period — invisible to the
 * allowance top-up logic that keys off exactly those fields. The tests here
 * are about that seam, not the happy path alone: a purchase must be tagged
 * correctly, must not masquerade as the "amount due" invoice, and confirming
 * it — including confirming it twice — must credit the allowance exactly
 * once.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let planId: string;

interface Tenant {
  orgId: string;
  clientId: string;
  ctx: TenantContext;
}

let acme: Tenant;

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
  plan: string | null,
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

  if (plan) {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: client.id,
      planId: plan,
      monthlyPriceCents: 9900,
      startedOn: "2026-01-01",
      status: "active",
    });
  }

  return {
    orgId: org.id,
    clientId: client.id,
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
  await db.delete(payments);
  await db.delete(paymentRequests);
  await db.delete(changeAllowances);
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(users);
  await db.delete(organizations);
  await db.delete(servicePlans);

  const plan = (
    await db
      .insert(servicePlans)
      .values({
        key: "care-basic",
        name: "Care — Basic",
        defaultMonthlyCents: 9900,
        includedChangesPerMonth: 3,
        overagePerChangeCents: 3900,
        includesAnalytics: true,
      })
      .returning()
  )[0]!;
  planId = plan.id;

  const adminUser = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: "admin@example.test",
        role: "admin",
        status: "active",
      })
      .returning()
  )[0]!;
  admin = adminContextFrom({
    userId: adminUser.id,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });

  acme = await seedTenant("acme", "acme@example.test", planId);
});

describe("starting a purchase", () => {
  it("tags the request as extra_change with the current period, not a bare subscription row", async () => {
    const outcome = await getOrCreateExtraChangeRequest(db, acme.ctx);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const row = (
      await db
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.publicId, outcome.publicId))
    )[0]!;

    expect(row.purpose).toBe("extra_change");
    expect(row.coversPeriodStart).not.toBeNull();
    expect(row.coversPeriodEnd).not.toBeNull();
    expect(row.amountCents).toBe(3900);
  });

  it("reuses an existing open request instead of minting a second one", async () => {
    const first = await getOrCreateExtraChangeRequest(db, acme.ctx);
    const second = await getOrCreateExtraChangeRequest(db, acme.ctx);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.publicId).toBe(first.publicId);
    expect(second.reference).toBe(first.reference);

    const rows = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.clientId, acme.clientId));
    expect(rows).toHaveLength(1);
  });

  it("refuses when the plan doesn't sell extra changes", async () => {
    await db
      .update(servicePlans)
      .set({ overagePerChangeCents: null })
      .where(eq(servicePlans.id, planId));

    const outcome = await getOrCreateExtraChangeRequest(db, acme.ctx);
    expect(outcome).toEqual({
      ok: false,
      reason: "not_offered",
      message: expect.any(String),
    });
  });

  it("does not appear as the 'amount due' invoice", async () => {
    // Regression: getBillingOverview's "current" query used to have no
    // purpose filter, so an extra-change request with no due date — often
    // the only open request a client has — would surface there mislabelled,
    // duplicating what the dedicated extra-change panel already shows.
    const outcome = await getOrCreateExtraChangeRequest(db, acme.ctx);
    expect(outcome.ok).toBe(true);

    const overview = await getBillingOverview(db, acme.ctx);
    expect(overview.current).toBeNull();
  });

  it("still surfaces a real subscription invoice as current alongside an open extra-change request", async () => {
    await getOrCreateExtraChangeRequest(db, acme.ctx);
    const invoice = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: "2026-09-01",
    });

    const overview = await getBillingOverview(db, acme.ctx);
    expect(overview.current?.publicId).toBe(invoice.publicId);
  });
});

describe("confirming a purchase credits the allowance", () => {
  it("creates a fresh allowance row already credited when none exists yet", async () => {
    const outcome = await getOrCreateExtraChangeRequest(db, acme.ctx);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await confirmPaymentReceived(admin, db, outcome.publicId, {
      method: "venmo",
      receivedOn: "2026-08-15",
    });

    const rows = await db
      .select()
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));

    expect(rows).toHaveLength(1);
    // The plan includes 3; buying one more should read as 4 available, not a
    // bare "1 purchased" row that ignores what the plan already grants.
    expect(rows[0]!.included).toBe(4);
    expect(rows[0]!.used).toBe(0);
  });

  it("tops up an existing allowance row rather than overwriting it", async () => {
    // The client has already used two of their three included changes this
    // month before buying a fourth.
    await db.insert(changeAllowances).values({
      clientId: acme.clientId,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      included: 3,
      used: 2,
    });

    const outcome = await getOrCreateExtraChangeRequest(
      db,
      acme.ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await confirmPaymentReceived(admin, db, outcome.publicId, {
      method: "cash",
      receivedOn: "2026-08-20",
    });

    const row = (
      await db
        .select()
        .from(changeAllowances)
        .where(eq(changeAllowances.clientId, acme.clientId))
    )[0]!;

    expect(row.included).toBe(4);
    // Usage already recorded this month must survive the top-up untouched.
    expect(row.used).toBe(2);
  });

  it("credits the allowance exactly once even if confirmed twice", async () => {
    const outcome = await getOrCreateExtraChangeRequest(db, acme.ctx);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await confirmPaymentReceived(admin, db, outcome.publicId, {
      method: "venmo",
      receivedOn: "2026-08-15",
    });
    // A retried confirmation, or a double-click on the operator's button.
    await confirmPaymentReceived(admin, db, outcome.publicId, {
      method: "venmo",
      receivedOn: "2026-08-15",
    });

    const row = (
      await db
        .select()
        .from(changeAllowances)
        .where(eq(changeAllowances.clientId, acme.clientId))
    )[0]!;
    expect(row.included).toBe(4);
  });

  it("does not touch the allowance when confirming an ordinary subscription invoice", async () => {
    const invoice = await raisePaymentRequest(admin, db, {
      organizationId: acme.orgId,
      amountCents: 9900,
      dueOn: "2026-09-01",
    });

    await confirmPaymentReceived(admin, db, invoice.publicId, {
      method: "cash",
      receivedOn: "2026-08-20",
    });

    const rows = await db
      .select()
      .from(changeAllowances)
      .where(eq(changeAllowances.clientId, acme.clientId));
    expect(rows).toHaveLength(0);
  });
});
