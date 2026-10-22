import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clientAddOns, clients, googleConnections, googleLocations, servicePlans, subscriptions, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { completeGoogleConnect, resetGoogleTokenCache } from "@/db/repositories/admin/google-connection";
import { linkGoogleLocation } from "@/db/repositories/admin/google-edits";
import { syncLocation } from "@/db/repositories/admin/google-sync";
import { buildReportData, loadReportSubjects } from "@/db/repositories/admin/report-builder";
import { REPORT_EXTENSIONS } from "@/lib/reports/extensions";
import { googleProfileReport } from "@/lib/reports/google-profile";
import { reportWindow } from "@/lib/reports/period";
import { createTestDb } from "./helpers/db";
import { fakeGoogle, sampleLocation, type FakeGoogle } from "./helpers/google-fake";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The monthly report's Google profile section, against a fake Google at the
 * HTTP boundary (so the tables hold what the real sync writes) and the real
 * migrations on PGlite.
 *
 * The failures worth a test are the quiet ones: an unlinked or never-synced
 * profile reported as "0 calls"; a month Google has only partly reported
 * presented as the whole month; reviews counted from a copy last refreshed
 * before the month began; a review from the evening of the 31st counted in
 * the wrong month; and one business's figures in another's report.
 */

const TZ = "America/Denver";
const SEPTEMBER = reportWindow("2026-09", TZ);
// 3 October 2026: Google has reported all of September by now.
const SYNCED_AT = new Date("2026-10-03T12:00:00.000Z");
const BUILT_AT = new Date("2026-10-03T15:00:00.000Z");

const ENV = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64"),
  AUTH_URL: "https://portal.example",
  AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
};
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let close: () => Promise<void>;
let admin: AdminContext;
let acme: SeededTenant;
let globex: SeededTenant;
let google: FakeGoogle;

function septemberDays(from = 1, to = 30): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `2026-09-${String(from + i).padStart(2, "0")}`);
}

/** A steady month: 40 views, 2 website clicks a day; calls on 12 days, directions on 5. */
function steadyMonth(locationName: string, days = septemberDays()) {
  days.forEach((day, i) => {
    google.setMetric(locationName, day, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", 30);
    google.setMetric(locationName, day, "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 10);
    google.setMetric(locationName, day, "WEBSITE_CLICKS", 2);
    if (i < 12) google.setMetric(locationName, day, "CALL_CLICKS", 1);
    if (i < 5) google.setMetric(locationName, day, "BUSINESS_DIRECTION_REQUESTS", 1);
  });
}

function review(locationName: string, reviewId: string, createTime: string) {
  google.addReview(locationName, { reviewId, reviewer: { displayName: "A customer" }, starRating: "FIVE", createTime });
}

/** Link the profile, then sync it as of `now` — the copy a report is built from. */
async function linkAndSync(tenant: SeededTenant, id: string, now = SYNCED_AT) {
  google.addLocation(sampleLocation(id));
  const [client] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, tenant.clientId));
  await linkGoogleLocation(admin, db, client!.publicId, { accountName: "accounts/111", locationName: `locations/${id}` });
  const [location] = await db.select().from(googleLocations).where(eq(googleLocations.organizationId, tenant.organizationId));
  await syncLocation(db, location!, { now, includeMetrics: true });
}

function build(tenant: SeededTenant, now = BUILT_AT) {
  return googleProfileReport.build({ db, organizationId: tenant.organizationId, window: SEPTEMBER, now });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [adminUser] = await db
    .insert(users)
    .values({ publicId: newPublicId(), email: "operator@example.test", name: "Scott", role: "admin", status: "active" })
    .returning({ id: users.id });
  admin = adminContextFrom({ userId: adminUser!.id, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
  acme = await seedTenant(db, "Acme Plumbing");
  globex = await seedTenant(db, "Globex Roofing");

  for (const [key, value] of Object.entries(ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await close();
});

beforeEach(async () => {
  vi.stubEnv("BUSINESS_TIMEZONE", TZ);
  // No analytics account on this server; the rest of the report says so.
  vi.stubEnv("UMAMI_API_BASE_URL", "");
  vi.stubEnv("UMAMI_API_KEY", "");
  google = fakeGoogle();
  vi.stubGlobal("fetch", google.fetch);
  resetGoogleTokenCache();
  await db.delete(googleLocations);
  await db.delete(googleConnections);
  await completeGoogleConnect(admin, db, { code: "code", codeVerifier: "verifier" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the Google profile section", () => {
  it("is registered for clients with Google profile management", () => {
    expect(REPORT_EXTENSIONS).toContain(googleProfileReport);
    expect(googleProfileReport).toMatchObject({ key: "google-profile", title: "Google profile", feature: "google-profile" });
  });

  it("reports the month's views, calls, clicks, directions and new reviews", async () => {
    steadyMonth("locations/456");
    // The edges: the evening of 31 August and of 30 September, Denver time.
    google.setMetric("locations/456", "2026-08-31", "CALL_CLICKS", 50);
    google.setMetric("locations/456", "2026-10-01", "CALL_CLICKS", 50);
    review("locations/456", "aug-31-evening", "2026-09-01T05:00:00Z");
    review("locations/456", "sep-03", "2026-09-03T16:00:00Z");
    review("locations/456", "sep-29", "2026-09-29T16:00:00Z");
    review("locations/456", "sep-30-evening", "2026-10-01T05:30:00Z");
    review("locations/456", "oct-02", "2026-10-02T16:00:00Z");
    await linkAndSync(acme, "456");

    expect(await build(acme)).toEqual({
      state: "ok",
      headline: "1,200 Google profile views",
      rows: [
        { label: "Profile views", value: "1,200" },
        { label: "Calls", value: "12" },
        { label: "Website clicks", value: "60" },
        { label: "Direction requests", value: "5" },
        { label: "New reviews", value: "3" },
      ],
      note: null,
    });
  });

  it("does not count a review its author has since deleted", async () => {
    steadyMonth("locations/456");
    review("locations/456", "sep-03", "2026-09-03T16:00:00Z");
    review("locations/456", "sep-10", "2026-09-10T16:00:00Z");
    await linkAndSync(acme, "456");
    google.state.reviews.set("locations/456", google.state.reviews.get("locations/456")!.filter((r) => r.reviewId !== "sep-10"));
    const [location] = await db.select().from(googleLocations).where(eq(googleLocations.organizationId, acme.organizationId));
    await syncLocation(db, location!, { now: SYNCED_AT, includeMetrics: true });

    const section = await build(acme);
    expect(section?.rows.find((r) => r.label === "New reviews")).toEqual({ label: "New reviews", value: "1" });
  });

  it("reports a quiet month Google did report as zeros, because they are figures", async () => {
    for (const day of septemberDays()) google.setMetric("locations/456", day, "CALL_CLICKS", 0);
    await linkAndSync(acme, "456");

    expect(await build(acme)).toEqual({
      state: "ok",
      headline: "0 Google profile views",
      rows: [
        { label: "Profile views", value: "0" },
        { label: "Calls", value: "0" },
        { label: "Website clicks", value: "0" },
        { label: "Direction requests", value: "0" },
        { label: "New reviews", value: "0" },
      ],
      note: null,
    });
  });

  it("says when Google has reported only part of the month, and how fresh the reviews are", async () => {
    // Synced on 28 September: Google had reported up to the 26th.
    steadyMonth("locations/456", septemberDays(1, 26));
    review("locations/456", "sep-03", "2026-09-03T16:00:00Z");
    await linkAndSync(acme, "456", new Date("2026-09-28T18:00:00.000Z"));

    const section = await build(acme, new Date("2026-10-01T15:00:00.000Z"));
    expect(section).toMatchObject({
      state: "ok",
      headline: "1,040 Google profile views",
      note: "Views, calls and clicks cover 26 of September's 30 days; Google had not reported the rest. Reviews counted to Sep 28.",
    });
    expect(section?.rows.find((r) => r.label === "New reviews")).toEqual({ label: "New reviews", value: "1" });
  });

  it("reports new reviews alone when Google sent no daily figures for the month", async () => {
    review("locations/456", "sep-03", "2026-09-03T16:00:00Z");
    review("locations/456", "sep-04", "2026-09-04T16:00:00Z");
    await linkAndSync(acme, "456");

    expect(await build(acme)).toEqual({
      state: "ok",
      headline: "2 new Google reviews",
      rows: [{ label: "New reviews", value: "2" }],
      note: "Google didn't report views, calls or clicks for September.",
    });
  });

  it("is missing, not zero, when no profile is linked", async () => {
    expect(await build(acme)).toEqual({
      state: "missing",
      headline: null,
      rows: [],
      note: "Your Google profile isn't linked to the portal yet, so there are no Google figures for September.",
    });
  });

  it("is missing, not zero, when the profile is linked but Google has never sent its figures", async () => {
    // The project as it stands: Business Information answers, the v4 reviews API is not enabled.
    google.failWhen((c) => c.url.host === "mybusiness.googleapis.com", 403, {
      error: {
        code: 403,
        message: "Google My Business API has not been used in project 1 before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    }, { times: 10 });
    steadyMonth("locations/456");
    google.addLocation(sampleLocation("456"));
    const [client] = await db.select({ publicId: clients.publicId }).from(clients).where(eq(clients.id, acme.clientId));
    await linkGoogleLocation(admin, db, client!.publicId, { accountName: "accounts/111", locationName: "locations/456" });

    expect(await build(acme)).toEqual({
      state: "missing",
      headline: null,
      rows: [],
      note: "Your Google profile is linked, but Google hasn't sent us its figures yet.",
    });
  });

  it("is missing when the copy was last refreshed before the month began", async () => {
    review("locations/456", "aug-10", "2026-08-10T16:00:00Z");
    await linkAndSync(acme, "456", new Date("2026-08-20T18:00:00.000Z"));

    expect(await build(acme)).toEqual({
      state: "missing",
      headline: null,
      rows: [],
      note: "Google hasn't sent figures for September. The last update was Aug 20.",
    });
  });

  it("counts only the business's own profile", async () => {
    steadyMonth("locations/456");
    review("locations/456", "acme-sep", "2026-09-03T16:00:00Z");
    steadyMonth("locations/789");
    review("locations/789", "globex-sep-1", "2026-09-05T16:00:00Z");
    review("locations/789", "globex-sep-2", "2026-09-06T16:00:00Z");
    await linkAndSync(acme, "456");
    await linkAndSync(globex, "789");

    const acmeSection = await build(acme);
    const globexSection = await build(globex);
    expect(acmeSection?.rows.find((r) => r.label === "New reviews")?.value).toBe("1");
    expect(acmeSection?.rows.find((r) => r.label === "Profile views")?.value).toBe("1,200");
    expect(globexSection?.rows.find((r) => r.label === "New reviews")?.value).toBe("2");

    await db.delete(googleLocations).where(eq(googleLocations.organizationId, globex.organizationId));
    expect((await build(globex))?.state).toBe("missing");
  });
});

describe("in the monthly report", () => {
  async function onPlan(tenant: SeededTenant, plan: string) {
    const [row] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, plan));
    await db.update(clients).set({ createdAt: new Date("2026-05-01T00:00:00.000Z") }).where(eq(clients.id, tenant.clientId));
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      planId: row!.id,
      monthlyPriceCents: 15000,
      billingDay: 1,
      startedOn: "2026-06-01",
      status: "active",
    });
  }

  async function reportFor(tenant: SeededTenant) {
    const [subject] = await loadReportSubjects(db, { organizationId: tenant.organizationId });
    return buildReportData(db, subject!, "2026-09", { now: BUILT_AT });
  }

  it("appears for a client whose plan includes it, and for one with the add-on", async () => {
    const pro = await seedTenant(db, "Pro Co");
    const care = await seedTenant(db, "Care Co");
    const growth = await seedTenant(db, "Growth Co");
    await onPlan(pro, "pro");
    await onPlan(care, "care");
    await onPlan(growth, "growth");
    await db.insert(clientAddOns).values({ clientId: care.clientId, featureKey: "google-profile", source: "operator" });
    steadyMonth("locations/901");
    await linkAndSync(pro, "901");

    const proExtras = (await reportFor(pro)).extras;
    expect(proExtras.find((e) => e.key === "google-profile")).toMatchObject({
      title: "Google profile",
      state: "ok",
      headline: "1,200 Google profile views",
    });
    expect((await reportFor(care)).extras.find((e) => e.key === "google-profile")).toMatchObject({ state: "missing" });
    expect((await reportFor(growth)).extras.find((e) => e.key === "google-profile")).toBeUndefined();
  });
});
