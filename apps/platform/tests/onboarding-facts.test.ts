import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BUILD } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import {
  businessProfiles,
  clientAddOns,
  clients,
  connectedAccounts,
  mediaAssets,
  payments,
  servicePlans,
  shopProducts,
  shopSettings,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { getOnboarding, loadOnboardingFacts } from "@/db/repositories/client/onboarding";
import { getClientSections } from "@/db/repositories/client/sections";
import { markBuildPaid } from "@/db/repositories/build-standing";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Get started, read from a real database: each to-do follows what is stored,
 * and the tab follows the required ones. The list's own rules are in
 * `onboarding-todos.test.ts`; this is about reading the right rows, for the
 * right tenant.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

const PASSWORD_CHOSEN = { passwordChosen: true };

async function facts(tenant: SeededTenant) {
  const loaded = await loadOnboardingFacts(db, tenant.ctx, PASSWORD_CHOSEN);
  if (!loaded) throw new Error("no client");
  return loaded;
}

/** The build paid: its ledger row, and the fact every payment path records beside it. */
async function payFor(tenant: SeededTenant) {
  await db.insert(payments).values({
    publicId: newPublicId(),
    clientId: tenant.clientId,
    amountCents: BUILD.priceCents,
    method: "cash",
    receivedOn: "2026-10-01",
  });
  await markBuildPaid(db, tenant.clientId, { source: "manual_payment" });
}

async function fillDetails(tenant: SeededTenant, details: Record<string, string>) {
  await db.insert(businessProfiles).values({ organizationId: tenant.organizationId, details });
}

async function addSite(tenant: SeededTenant) {
  const [site] = await db
    .insert(sites)
    .values({ publicId: newPublicId(), organizationId: tenant.organizationId, name: "Main site", status: "live" })
    .returning();
  return site!;
}

const ALL_DETAILS = { phone: "801-555-0100", email: "hello@acme.test", hours: "Mon–Fri 8–5", services: "Repairs" };

describe("loadOnboardingFacts", () => {
  it("reads a brand-new client as owing the build, with nothing filled in", async () => {
    const tenant = await seedTenant(db, "Fresh");

    expect(await facts(tenant)).toMatchObject({
      sitePayment: { state: "due", amountCents: BUILD.priceCents },
      businessDetailsMissing: ["phone", "email", "hours", "services"],
      hasAddress: false,
      addressRequired: false,
      plan: { state: "none" },
      mediaReady: 0,
      listings: null,
      searchConsole: "not_connected",
      booking: { enabled: false },
      shop: { enabled: false },
    });
  });

  it("follows the ledger, the profile, the library, the checklist and connections", async () => {
    const tenant = await seedTenant(db, "Busy");
    await payFor(tenant);
    await fillDetails(tenant, { ...ALL_DETAILS, address: "1 Main St, Provo, UT" });
    await addSite(tenant);
    await db.insert(mediaAssets).values([
      { publicId: newPublicId(), organizationId: tenant.organizationId, originalFilename: "logo.png", status: "ready", storageKey: `media/${newPublicId()}`, contentType: "image/png", byteSize: 2048, checksumSha256: "a".repeat(64) },
      { publicId: newPublicId(), organizationId: tenant.organizationId, originalFilename: "van.jpg", status: "failed" },
    ]);
    await db.insert(connectedAccounts).values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      provider: "google",
      externalId: "google-subject",
      status: "needs_reconnect",
    });

    const loaded = await facts(tenant);

    expect(loaded).toMatchObject({
      sitePayment: { state: "paid" },
      businessDetailsMissing: [],
      hasAddress: true,
      mediaReady: 1,
      searchConsole: "needs_reconnect",
    });
    expect(loaded.listings).toMatchObject({ done: 0 });
    expect(loaded.listings!.total).toBeGreaterThan(0);
  });

  it("treats whitespace as an empty field", async () => {
    const tenant = await seedTenant(db, "Blank");
    await fillDetails(tenant, { ...ALL_DETAILS, hours: "   " });

    expect((await facts(tenant)).businessDetailsMissing).toEqual(["hours"]);
  });

  it("requires a postal address once win-back email is theirs", async () => {
    const tenant = await seedTenant(db, "Winback");
    await db.insert(clientAddOns).values({ clientId: tenant.clientId, featureKey: "winback", source: "operator" });

    expect((await facts(tenant)).addressRequired).toBe(true);
  });

  it("reads a complimentary client as owing nothing, with their plan granted", async () => {
    const tenant = await seedTenant(db, "Comped");
    const [comp] = await db
      .insert(servicePlans)
      .values({ key: `comp-${newPublicId().slice(0, 6)}`, name: "Complimentary", defaultMonthlyCents: 0 })
      .returning({ id: servicePlans.id });
    await db.update(clients).set({ compPlanId: comp!.id }).where(eq(clients.id, tenant.clientId));

    expect(await facts(tenant)).toMatchObject({
      sitePayment: { state: "not_needed" },
      plan: { state: "complimentary" },
    });
  });

  it("reads the shop's Stripe account and products for a store", async () => {
    const tenant = await seedTenant(db, "Store");
    await db.update(clients).set({ shopEnabled: true }).where(eq(clients.id, tenant.clientId));
    const site = await addSite(tenant);
    await db.insert(shopSettings).values({
      organizationId: tenant.organizationId,
      siteId: site.id,
      stripeAccountId: "acct_test",
      chargesEnabled: true,
    });
    await db.insert(shopProducts).values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      siteId: site.id,
      name: "Honey",
      slug: "honey",
      priceCents: 1200,
    });

    expect((await facts(tenant)).shop).toEqual({ enabled: true, paymentsReady: true, productCount: 1 });
  });

  it("marks availability not ready for a booking site until it is wired at merge", async () => {
    const tenant = await seedTenant(db, "Bookings");
    await db.update(clients).set({ bookingEnabled: true }).where(eq(clients.id, tenant.clientId));

    expect((await facts(tenant)).booking).toEqual({ enabled: true, availabilityReady: false });
  });

  it("reads only the caller's own records", async () => {
    const mine = await seedTenant(db, "Mine");
    const theirs = await seedTenant(db, "Theirs");
    await payFor(theirs);
    await fillDetails(theirs, ALL_DETAILS);

    expect(await facts(mine)).toMatchObject({
      sitePayment: { state: "due" },
      businessDetailsMissing: ["phone", "email", "hours", "services"],
    });
  });
});

describe("getOnboarding", () => {
  it("counts progress over the whole list", async () => {
    const tenant = await seedTenant(db, "Counted");
    await fillDetails(tenant, ALL_DETAILS);

    const onboarding = await getOnboarding(db, tenant.ctx, PASSWORD_CHOSEN);

    expect(onboarding?.progress).toMatchObject({ done: 2, requiredLeft: 1 });
    expect(onboarding?.todos.find((t) => !t.done && t.required)?.key).toBe("pay");
  });
});

describe("the Get started tab", () => {
  it("shows while a required to-do is left, and goes once they are done", async () => {
    const tenant = await seedTenant(db, "Tabbed");
    expect((await getClientSections(db, tenant.ctx)).getStarted).toBe(true);

    await payFor(tenant);
    expect((await getClientSections(db, tenant.ctx)).getStarted).toBe(true);

    await fillDetails(tenant, ALL_DETAILS);
    expect((await getClientSections(db, tenant.ctx)).getStarted).toBe(false);
  });

  it("is not held open by optional to-dos", async () => {
    const tenant = await seedTenant(db, "Optional");
    await payFor(tenant);
    await fillDetails(tenant, ALL_DETAILS);

    const onboarding = await getOnboarding(db, tenant.ctx, PASSWORD_CHOSEN);
    expect(onboarding?.progress.done).toBeLessThan(onboarding!.progress.total);
    expect((await getClientSections(db, tenant.ctx)).getStarted).toBe(false);
  });

  it("stays for a store until the shop can sell", async () => {
    const tenant = await seedTenant(db, "Shopfront");
    await payFor(tenant);
    await fillDetails(tenant, ALL_DETAILS);
    await db.update(clients).set({ shopEnabled: true }).where(eq(clients.id, tenant.clientId));

    expect(await getClientSections(db, tenant.ctx)).toEqual({ getStarted: true, availability: false, shop: true });
  });
});
