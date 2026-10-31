import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  changeRequests,
  clients,
  requestEvents,
  servicePlans,
  subscriptions,
  users,
} from "@/db/schema";
import type { AdminContext } from "@/db/repositories/context";
import { markBuildPaid } from "@/db/repositories/build-standing";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Decision D7 through the real submit action: before the build is paid and
 * with no plan, one small change a month and no big ones; everyone else on
 * their plan's rules. Only the edges are faked — the session, the database
 * handle, Next's cache.
 */

let db: Database;
let close: () => Promise<void>;
const session: { current: Record<string, unknown> | null } = { current: null };

vi.mock("@/auth", () => ({ currentUser: async () => session.current }));
vi.mock("@/db/client", () => ({ getDb: async () => db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/scheduler/nudge", () => ({ nudgeScheduler: () => undefined }));

const { submitChangeRequest } = await import("@/app/dashboard/requests/actions");
const { changeTierOf, freeSmallChangesUsed } = await import("@/db/repositories/change-tier");
const { setRequestSize } = await import("@/db/repositories/admin/request-size");
const { bookingAccess } = await import("@/db/repositories/client/availability");
const { canUseFeature, getGrowthState } = await import("@/db/repositories/client/growth");

let tenant: SeededTenant;

function signInAs(t: SeededTenant) {
  session.current = { userId: t.userId, organizationId: t.organizationId, role: "client", status: "active", sessionEpoch: 0 };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  data.set("title", "Change the phone number");
  data.set("description", "It should be 555-0100");
  data.set("idempotencyKey", newPublicId());
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const submit = (values: Record<string, string>) => submitChangeRequest(null, form(values));

/** The client's requests, newest first. */
async function requestsOf(t: SeededTenant) {
  return db.select().from(changeRequests).where(eq(changeRequests.organizationId, t.organizationId));
}

/** Out of the way of "one at a time", as if it shipped. */
async function finishAll(t: SeededTenant) {
  await db.update(changeRequests).set({ status: "verified" }).where(eq(changeRequests.organizationId, t.organizationId));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  tenant = await seedTenant(db, `Free ${newPublicId().slice(0, 4)}`);
  signInAs(tenant);
});

describe("before the build is paid, with no plan", () => {
  it("takes the month's first small change, free and outside any plan allowance", async () => {
    const result = await submit({ size: "small" });

    expect(result).toMatchObject({ ok: true, remaining: 0 });
    const [request] = await requestsOf(tenant);
    expect(request).toMatchObject({ size: "small", billing: "courtesy", allowanceId: null });
  });

  it("refuses a second small change in the same month", async () => {
    await submit({ size: "small" });
    await finishAll(tenant);

    const second = await submit({ size: "small" });

    expect(second).toMatchObject({ ok: false, reason: "free_change_used" });
    expect(await requestsOf(tenant)).toHaveLength(1);
  });

  it("takes one again the next month", async () => {
    await submit({ size: "small" });
    await finishAll(tenant);
    await db
      .update(changeRequests)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(changeRequests.organizationId, tenant.organizationId));

    expect(await submit({ size: "small" })).toMatchObject({ ok: true });
  });

  it("hands a cancelled free change back", async () => {
    await submit({ size: "small" });
    const [request] = await requestsOf(tenant);
    await finishAll(tenant);
    await db.insert(requestEvents).values({
      requestId: request!.id,
      actorType: "client",
      kind: "request_cancelled",
      body: "Cancelled before it went live.",
      visibility: "client_visible",
    });

    expect(await submit({ size: "small" })).toMatchObject({ ok: true });
  });

  it("refuses a big change, pointing at putting the site live", async () => {
    const result = await submit({ size: "big" });

    expect(result).toMatchObject({ ok: false, reason: "needs_payment" });
    expect(await requestsOf(tenant)).toEqual([]);
  });

  it("asks for a size rather than guessing one", async () => {
    expect(await submit({})).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("does not count an operator's own courtesy work against the client", async () => {
    const [admin] = await db
      .insert(users)
      .values({ publicId: newPublicId(), email: `op-${newPublicId().toLowerCase()}@example.test`, role: "admin", status: "active" })
      .returning({ id: users.id });
    await db.insert(changeRequests).values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      createdByUserId: admin!.id,
      title: "Fix the footer",
      size: "small",
      billing: "courtesy",
      status: "verified",
    });

    expect(await freeSmallChangesUsed(db, tenant.organizationId)).toBe(0);
    expect(await submit({ size: "small" })).toMatchObject({ ok: true });
  });

  it("leaves booking and the shop open: neither waits on payment", async () => {
    await db
      .update(clients)
      .set({ bookingEnabled: true, shopEnabled: true })
      .where(eq(clients.id, tenant.clientId));

    expect((await changeTierOf(db, tenant.clientId))?.tier).toBe("free");
    expect((await bookingAccess(db, tenant.ctx)).allowed).toBe(true);
    expect(canUseFeature(await getGrowthState(db, tenant.ctx), "shop")).toBe(true);
  });
});

describe("a client who has paid", () => {
  it("keeps their plan's rules once the build is paid: a big change goes through, on the allowance", async () => {
    await markBuildPaid(db, tenant.clientId, { source: "manual_payment" });

    const result = await submit({ size: "big" });

    expect(result).toMatchObject({ ok: true });
    const [request] = await requestsOf(tenant);
    expect(request).toMatchObject({ size: "big", billing: "included" });
    expect(request!.allowanceId).not.toBeNull();
  });

  it("is on their plan when Stripe charges one, even with the build still owed", async () => {
    const [plan] = await db.select({ id: servicePlans.id }).from(servicePlans).limit(1);
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      planId: plan!.id,
      status: "active",
      provider: "stripe",
      providerSubscriptionId: `sub_${newPublicId()}`,
      startedOn: "2026-10-01",
      monthlyPriceCents: 5000,
    });

    expect(await changeTierOf(db, tenant.clientId)).toEqual({ tier: "plan", reason: "paid_plan" });
  });

  it("is not on a plan an operator only assigned, which nobody has paid", async () => {
    const [plan] = await db.select({ id: servicePlans.id }).from(servicePlans).limit(1);
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      planId: plan!.id,
      status: "active",
      startedOn: "2026-10-01",
      monthlyPriceCents: 5000,
    });

    expect(await changeTierOf(db, tenant.clientId)).toEqual({ tier: "free" });
  });

  it("counts complimentary and the agency's own as on a plan", async () => {
    await db.update(clients).set({ isInternal: true }).where(eq(clients.id, tenant.clientId));
    expect(await changeTierOf(db, tenant.clientId)).toEqual({ tier: "plan", reason: "internal" });
  });
});

describe("an operator correcting the size", () => {
  const admin = () => ({ userId: tenant.userId }) as AdminContext;

  it("records the new size and who changed it from what", async () => {
    await submit({ size: "small" });
    const [request] = await requestsOf(tenant);

    expect(await setRequestSize(admin(), db, request!.publicId, "big")).toEqual({ ok: true, changed: true });
    expect(await setRequestSize(admin(), db, request!.publicId, "big")).toEqual({ ok: true, changed: false });

    const [after] = await requestsOf(tenant);
    expect(after!.size).toBe("big");
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "request.size_changed"), eq(auditLog.entityId, request!.publicId)));
    expect(audit.map((a) => a.metadata)).toEqual([{ from: "small", to: "big" }]);
  });

  it("reports a request that does not exist", async () => {
    expect(await setRequestSize(admin(), db, "nope", "small")).toEqual({ ok: false, reason: "not_found" });
  });
});
