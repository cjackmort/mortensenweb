import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { BUILDS } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { auditLog, clients, users } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";
import { addPrice, fakeStripe, resetFakeStripe } from "./helpers/fake-stripe";

/**
 * The operator's half of the cart: which build a client pays for, and the
 * promo codes that come off it.
 *
 * Worth testing: a code made here that could come off a plan, a build price
 * set to something the catalogue does not sell, a price changed after the
 * client has paid, and no record of who made or switched off a code.
 */

vi.mock("@/lib/payments/stripe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/stripe")>("@/lib/payments/stripe");
  const { fakeStripe: fake } = await import("./helpers/fake-stripe");
  return { ...actual, requireStripe: () => fake.client as never };
});

const promos = await import("@/db/repositories/admin/build-promos");
const builds = await import("@/db/repositories/admin/client-build");

const BUILD_PRODUCT = "prod_website_build";

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let acme: SeededTenant;
let acmePublicId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  const [adminUser] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "admin@example.test", role: "admin", status: "active" })
    .returning();
  admin = adminContextFrom({ userId: adminUser!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  resetFakeStripe();
  for (const build of BUILDS) addPrice(`build_${build.key}_v1`, build.priceCents, BUILD_PRODUCT, false);
  acme = await seedTenant(db, `Acme ${newPublicId()}`);
  const [row] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, acme.clientId));
  acmePublicId = row!.publicId;
});

describe("promo codes for the website", () => {
  it("makes a code restricted to the build product and records who made it", async () => {
    const result = await promos.createPromoCode(admin, db, { code: "WEB100", kind: "amount", value: 10000 });

    expect(result).toMatchObject({ ok: true, code: "WEB100" });
    const coupon = [...fakeStripe.state.coupons.values()][0]!;
    expect(coupon.applies_to).toEqual({ products: [BUILD_PRODUCT] });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "promo.created"));
    expect(entry).toMatchObject({ actorUserId: admin.userId, metadata: expect.objectContaining({ code: "WEB100" }) });
  });

  it("lists codes with whether the cart accepts them", async () => {
    await promos.createPromoCode(admin, db, { code: "QUARTER", kind: "percent", value: 25 });

    const listing = await promos.listPromoCodes(admin);

    expect(listing).toMatchObject({ ready: true, rows: [{ code: "QUARTER", buildOnly: true, terms: "25% off the website" }] });
  });

  it("switches a code off and records it", async () => {
    const made = await promos.createPromoCode(admin, db, { code: "GONE", kind: "amount", value: 500 });
    await promos.deactivatePromoCode(admin, db, made.ok ? made.id : "");

    expect([...fakeStripe.state.promos.values()][0]!.active).toBe(false);
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "promo.deactivated"));
    expect(entries).toHaveLength(1);
  });

  it("says the build product is missing rather than making an unrestricted code", async () => {
    fakeStripe.state.prices.clear();

    const result = await promos.createPromoCode(admin, db, { code: "NOWHERE", kind: "amount", value: 500 });

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/stripe:setup/) });
    expect(fakeStripe.state.coupons.size).toBe(0);
  });
});

describe("the build on a client's record", () => {
  it("sets the build and a quoted price", async () => {
    const build = BUILDS[0]!;

    const result = await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: build.key, price: "350" });

    expect(result).toMatchObject({ ok: true });
    const [row] = await db.select({ key: clients.buildKey, cents: clients.buildPriceCents }).from(clients).where(eq(clients.id, acme.clientId));
    expect(row).toEqual({ key: build.key, cents: 35000 });
  });

  it("clears a quoted price back to the list price", async () => {
    const build = BUILDS[0]!;
    await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: build.key, price: "350" });

    await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: build.key, price: "" });

    const view = await builds.getClientBuild(admin, db, acmePublicId);
    expect(view).toMatchObject({ buildKey: build.key, priceCents: build.priceCents, quoted: false });
  });

  it("refuses a build the catalogue does not sell, and a price that is not money", async () => {
    expect(await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: "mansion", price: "" })).toMatchObject({ ok: false });
    expect(await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: BUILDS[0]!.key, price: "-5" })).toMatchObject({ ok: false });
    expect(await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: BUILDS[0]!.key, price: "abc" })).toMatchObject({ ok: false });
  });

  it("refuses to change the price once the client has paid", async () => {
    await db.update(clients).set({ buildPaidAt: new Date() }).where(eq(clients.id, acme.clientId));

    const result = await builds.setClientBuild(admin, db, { clientPublicId: acmePublicId, buildKey: BUILDS[0]!.key, price: "1" });

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/already paid/) });
  });
});
