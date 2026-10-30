import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { GROWTH_FEATURES, type GrowthFeatureKey } from "@mortensenweb/plans";
import { auditLog, clients } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { createClient, setClientSections } from "@/db/repositories/admin/clients";
import {
  canUseFeature,
  getGrowthState,
  growthHubFeatures,
  openedEarly,
  requireUsableGrowthFeature,
  type GrowthState,
} from "@/db/repositories/client/growth";
import { growthAccess } from "@/lib/growth/access";
import { createTestDb } from "./helpers/db";
import { seedTenant } from "./helpers/tenant";

/**
 * What kind of site a client has: a booking portal, a store, both or
 * neither, chosen by the operator.
 *
 * What would go wrong quietly: the flag saved but the shop still closed (the
 * client sees a Shop tab that bounces them to Growth); the shop open for a
 * client who never asked for one; a "coming soon" shop card on every other
 * client's Growth page; a change to what a client can sell with no record of
 * who made it.
 */

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const operator = await seedTenant(db, "Operator Org");
  admin = adminContextFrom({ userId: operator.userId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => {
  await close();
});

async function clientRow(publicId: string) {
  const [row] = await db
    .select({ bookingEnabled: clients.bookingEnabled, shopEnabled: clients.shopEnabled, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.publicId, publicId));
  return row!;
}

async function auditFor(publicId: string, action: string) {
  return db
    .select({ metadata: auditLog.metadata, actorUserId: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, publicId), eq(auditLog.action, action)));
}

describe("adding a client", () => {
  it("saves a booking portal, a store, both or neither", async () => {
    const cases = [
      { bookingEnabled: true, shopEnabled: false },
      { bookingEnabled: false, shopEnabled: true },
      { bookingEnabled: true, shopEnabled: true },
      { bookingEnabled: false, shopEnabled: false },
    ];
    for (const kinds of cases) {
      const created = await createClient(admin, db, { businessName: `Kinds ${JSON.stringify(kinds)}`, ...kinds });
      expect(await clientRow(created.clientPublicId)).toMatchObject(kinds);
    }
  });

  it("leaves both off when the form says nothing", async () => {
    const created = await createClient(admin, db, { businessName: "Plain Co" });
    expect(await clientRow(created.clientPublicId)).toMatchObject({ bookingEnabled: false, shopEnabled: false });
  });

  it("records the kind of site in the audit log", async () => {
    const created = await createClient(admin, db, { businessName: "Audited Store", shopEnabled: true });
    const [row] = await auditFor(created.clientPublicId, "client.created");
    expect(row!.metadata).toMatchObject({ bookingEnabled: false, shopEnabled: true });
    expect(row!.actorUserId).toBe(admin.userId);
  });
});

describe("changing the kind of site later", () => {
  it("saves the change and audits what it was and what it became", async () => {
    const { clientPublicId } = await createClient(admin, db, { businessName: "Turns Into A Store" });

    const outcome = await setClientSections(admin, db, clientPublicId, { bookingEnabled: true, shopEnabled: true });

    expect(outcome).toEqual({ ok: true, changed: true });
    expect(await clientRow(clientPublicId)).toMatchObject({ bookingEnabled: true, shopEnabled: true });
    const [row] = await auditFor(clientPublicId, "client.sections_changed");
    expect(row!.metadata).toEqual({
      from: { bookingEnabled: false, shopEnabled: false },
      to: { bookingEnabled: true, shopEnabled: true },
    });
  });

  it("writes nothing when nothing changed", async () => {
    const { clientPublicId } = await createClient(admin, db, { businessName: "Already A Store", shopEnabled: true });

    const outcome = await setClientSections(admin, db, clientPublicId, { bookingEnabled: false, shopEnabled: true });

    expect(outcome).toEqual({ ok: true, changed: false });
    expect(await auditFor(clientPublicId, "client.sections_changed")).toHaveLength(0);
  });

  it("says so for a client that does not exist", async () => {
    expect(await setClientSections(admin, db, "NOPE000000", { bookingEnabled: true, shopEnabled: false })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("the shop follows the store flag", () => {
  it("stays closed for a client who is not a store, though the shop is free", async () => {
    const t = await seedTenant(db, "Not A Store");
    const state = await getGrowthState(db, t.ctx);
    expect(state.shopEnabled).toBe(false);
    expect(canUseFeature(state, "shop")).toBe(false);
    expect(await requireUsableGrowthFeature(db, t.ctx, "shop")).toBe(false);
  });

  it("opens for a store client before the shop is released to everyone", async () => {
    const t = await seedTenant(db, "Pottery Store");
    await db.update(clients).set({ shopEnabled: true }).where(eq(clients.id, t.clientId));

    const state = await getGrowthState(db, t.ctx);
    expect(state.shopEnabled).toBe(true);
    expect(canUseFeature(state, "shop")).toBe(true);
    expect(await requireUsableGrowthFeature(db, t.ctx, "shop")).toBe(true);
  });

  it("does not open for a booking portal", async () => {
    const t = await seedTenant(db, "Booking Only");
    await db.update(clients).set({ bookingEnabled: true }).where(eq(clients.id, t.clientId));

    const state = await getGrowthState(db, t.ctx);
    expect(state.bookingEnabled).toBe(true);
    expect(canUseFeature(state, "shop")).toBe(false);
  });

  it("still opens early on the agency's own site", async () => {
    const t = await seedTenant(db, "Agency Site");
    await db.update(clients).set({ isInternal: true }).where(eq(clients.id, t.clientId));
    expect(await requireUsableGrowthFeature(db, t.ctx, "shop")).toBe(true);
  });

  it("closes again when the operator turns the store off", async () => {
    const t = await seedTenant(db, "Closing Store");
    const [row] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, t.clientId));
    await setClientSections(admin, db, row!.publicId, { bookingEnabled: false, shopEnabled: true });
    expect(await requireUsableGrowthFeature(db, t.ctx, "shop")).toBe(true);
    await setClientSections(admin, db, row!.publicId, { bookingEnabled: false, shopEnabled: false });
    expect(await requireUsableGrowthFeature(db, t.ctx, "shop")).toBe(false);
  });
});

/** A Growth state built by hand, for the rules that do not need a database. */
function stateWith(overrides: Partial<GrowthState> & { unbuilt?: GrowthFeatureKey } = {}): GrowthState {
  const { unbuilt, ...rest } = overrides;
  const access = growthAccess({ planKey: "pro", comped: false, addOns: [] }).map((a) =>
    a.feature.key === unbuilt ? { ...a, feature: { ...a.feature, available: false } } : a,
  );
  return {
    access,
    planKey: "pro",
    planName: "Pro",
    monthlyPriceCents: 15000,
    billing: "stripe",
    cancelsOn: null,
    renewsOn: null,
    addOns: [],
    earlyAccess: false,
    shopEnabled: false,
    bookingEnabled: false,
    ...rest,
  };
}

describe("the store flag opens the shop and nothing else", () => {
  it("leaves every other feature to its plan and its release", () => {
    const store = stateWith({ shopEnabled: true, bookingEnabled: true });
    const plain = stateWith();
    for (const feature of GROWTH_FEATURES.filter((f) => f.key !== "shop")) {
      expect(canUseFeature(store, feature.key), feature.key).toBe(canUseFeature(plain, feature.key));
    }
  });

  it("does not open another unbuilt feature for a store", () => {
    expect(canUseFeature(stateWith({ shopEnabled: true, unbuilt: "campaigns" }), "campaigns")).toBe(false);
  });
});

describe("the Growth page", () => {
  const keys = (state: GrowthState) => growthHubFeatures(state).map((a) => a.feature.key);

  it("shows the shop card only to a store", () => {
    expect(keys(stateWith({ shopEnabled: true }))).toContain("shop");
    expect(keys(stateWith())).not.toContain("shop");
    expect(keys(stateWith({ bookingEnabled: true }))).not.toContain("shop");
  });

  it("shows it on the agency's own site, where it is tried early", () => {
    expect(keys(stateWith({ earlyAccess: true }))).toContain("shop");
  });

  it("says 'trying it early' on the agency's site, not to a store that simply has the shop", () => {
    expect(openedEarly(stateWith({ shopEnabled: true }), "shop")).toBe(false);
    expect(openedEarly(stateWith({ earlyAccess: true }), "shop")).toBe(true);
    expect(openedEarly(stateWith({ earlyAccess: true, shopEnabled: true }), "shop")).toBe(false);
    expect(openedEarly(stateWith({ earlyAccess: true }), "search")).toBe(false);
  });

  it("keeps every other card", () => {
    const others = GROWTH_FEATURES.filter((f) => f.key !== "shop").map((f) => f.key);
    expect(keys(stateWith())).toEqual(others);
  });
});
