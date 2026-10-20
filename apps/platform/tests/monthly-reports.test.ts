import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  clients,
  leads,
  monthlyReports,
  servicePlans,
  sites,
  subscriptions,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { adminContextFrom, tenantContextFrom } from "@/db/repositories/context";
import {
  buildReportData,
  loadReportSubjects,
  saveReport,
} from "@/db/repositories/admin/report-builder";
import { runScheduledMonthlyReports } from "@/db/repositories/admin/report-delivery";
import {
  getClientReportPreview,
  rebuildClientReport,
  resendClientReport,
  setClientReportEmails,
} from "@/db/repositories/admin/reports";
import {
  getMyReport,
  getMyReportEmails,
  hasMonthlyReport,
  listMyReports,
  setMyReportEmails,
} from "@/db/repositories/client/reports";
import type { ReportExtension } from "@/lib/reports/extensions";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Monthly reports, end to end against the real schema.
 *
 * The failures worth a test are the quiet ones: a client emailed twice by two
 * overlapping scheduler runs, a client who opted out emailed anyway, a
 * cancelled change reported as done, an unconnected form reported as "0
 * enquiries", and one client's report readable by another.
 */

const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; text: string; html: string }) => {
    sent.push(message);
    return { status: "sent", id: "test" };
  }),
}));

let db: Database;
let close: () => Promise<void>;

// 1 October 2026, 9am in Denver: the first sweep of the month.
const FIRST_OF_OCTOBER = new Date("2026-10-01T15:00:00.000Z");
const MID_SEPTEMBER = new Date("2026-09-15T18:00:00.000Z");
const MID_AUGUST = new Date("2026-08-15T18:00:00.000Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => close());

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv("BUSINESS_TIMEZONE", "America/Denver");
  vi.stubEnv("AUTH_URL", "https://portal.example.test");
  // No analytics account on this server: every report must say so.
  vi.stubEnv("UMAMI_API_BASE_URL", "");
  vi.stubEnv("UMAMI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function planId(key: string): Promise<string> {
  const [row] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, key));
  return row!.id;
}

interface Client extends SeededTenant {
  publicId: string;
}

async function client(
  name: string,
  { plan = "care", startedOn = "2026-06-01", isDemo = false }: { plan?: string | null; startedOn?: string; isDemo?: boolean } = {},
): Promise<Client> {
  const tenant = await seedTenant(db, name);
  const [row] = await db
    .update(clients)
    .set({ createdAt: new Date("2026-05-01T00:00:00.000Z"), isDemo })
    .where(eq(clients.id, tenant.clientId))
    .returning({ publicId: clients.publicId });
  if (plan) {
    await db.insert(subscriptions).values({
      publicId: newPublicId(),
      clientId: tenant.clientId,
      planId: await planId(plan),
      monthlyPriceCents: 5000,
      billingDay: 1,
      startedOn,
      status: "active",
    });
  }
  return { ...tenant, publicId: row!.publicId };
}

async function site(tenant: SeededTenant, overrides: Partial<typeof sites.$inferInsert> = {}) {
  const [row] = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: tenant.organizationId,
      name: "Main site",
      primaryDomain: "acme.example",
      status: "live",
      liveVerifiedAt: new Date("2026-10-01T12:00:00.000Z"),
      formsConnectedAt: new Date("2026-06-01T00:00:00.000Z"),
      ...overrides,
    })
    .returning({ id: sites.id });
  return row!.id;
}

async function lead(tenant: SeededTenant, siteId: string, receivedAt: Date, extra: Partial<typeof leads.$inferInsert> = {}) {
  await db.insert(leads).values({
    publicId: newPublicId(),
    organizationId: tenant.organizationId,
    siteId,
    providerSubmissionId: newPublicId(),
    receivedAt,
    ...extra,
  });
}

async function change(tenant: SeededTenant, title: string, status: "verified" | "closed", closedAt: Date) {
  await db.insert(changeRequests).values({
    publicId: newPublicId(),
    organizationId: tenant.organizationId,
    title,
    status,
    closedAt,
  });
}

async function subjectFor(tenant: SeededTenant) {
  const [subject] = await loadReportSubjects(db, { organizationId: tenant.organizationId });
  return subject!;
}

function adminCtx(tenant: SeededTenant) {
  return adminContextFrom({ userId: tenant.userId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
}

describe("building a report", () => {
  it("counts the month's enquiries and finished changes, and nothing else", async () => {
    const acme = await client("Acme");
    const siteId = await site(acme);
    await lead(acme, siteId, MID_SEPTEMBER, { status: "won" });
    await lead(acme, siteId, MID_SEPTEMBER);
    await lead(acme, siteId, new Date("2026-09-30T23:30:00.000Z")); // 5:30pm on the 30th in Denver
    await lead(acme, siteId, new Date("2026-10-01T05:30:00.000Z")); // 11:30pm on the 30th in Denver
    await lead(acme, siteId, new Date("2026-10-01T06:30:00.000Z")); // October
    await lead(acme, siteId, MID_SEPTEMBER, { deletedAt: new Date() });
    await lead(acme, siteId, MID_AUGUST);
    await change(acme, "Update Saturday hours", "verified", new Date("2026-09-04T17:00:00.000Z"));
    await change(acme, "Cancelled idea", "closed", new Date("2026-09-05T17:00:00.000Z"));
    await change(acme, "October change", "verified", new Date("2026-10-02T17:00:00.000Z"));

    const data = await buildReportData(db, await subjectFor(acme), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });

    expect(data.enquiries).toEqual({ state: "ok", received: 4, previous: 1, won: 1, awaitingReply: 3 });
    expect(data.changes.items).toEqual([{ title: "Update Saturday hours", completedAt: "2026-09-04T17:00:00.000Z" }]);
    expect(data.health).toEqual({ state: "ok", live: true, lastConfirmedAt: "2026-10-01T12:00:00.000Z", stale: false });
    expect(data.site).toEqual({ name: "Main site", domain: "acme.example" });
  });

  it("says analytics is not connected rather than reporting zero visitors", async () => {
    const acme = await client("Acme analytics");
    await site(acme);
    const data = await buildReportData(db, await subjectFor(acme), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(data.visitors).toEqual({ state: "missing", reason: "analytics_not_configured" });
    expect(data.contact).toEqual({ state: "missing", reason: "analytics_not_configured" });
  });

  it("says the form is not connected rather than reporting zero enquiries", async () => {
    const acme = await client("Acme forms");
    await site(acme, { formsConnectedAt: null });
    const data = await buildReportData(db, await subjectFor(acme), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(data.enquiries).toEqual({ state: "missing", reason: "forms_not_connected" });
  });

  it("flags a live site the portal has not confirmed online for days", async () => {
    const acme = await client("Acme stale");
    await site(acme, { liveVerifiedAt: new Date("2026-09-20T12:00:00.000Z") });
    const data = await buildReportData(db, await subjectFor(acme), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(data.health).toMatchObject({ state: "ok", stale: true, lastConfirmedAt: "2026-09-20T12:00:00.000Z" });
  });

  it("says there is no site, for a client without one", async () => {
    const acme = await client("Acme no site");
    const data = await buildReportData(db, await subjectFor(acme), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(data.site).toBeNull();
    expect(data.visitors).toEqual({ state: "missing", reason: "no_site" });
    expect(data.health).toEqual({ state: "missing", reason: "no_site" });
  });

  it("leaves out the leads inbox for a plan without it", async () => {
    const lite = await client("Lite Co", { plan: "lite" });
    await site(lite);
    const data = await buildReportData(db, await subjectFor(lite), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(data.enquiries).toBeNull();
  });
});

describe("Growth sections", () => {
  const reviews: ReportExtension = {
    key: "reviews",
    title: "Google reviews",
    feature: "reviews",
    build: async () => ({ state: "ok", headline: "4 new reviews", rows: [{ label: "New reviews", value: "4" }], note: null }),
  };
  const broken: ReportExtension = {
    key: "campaigns",
    title: "Campaigns",
    feature: "campaigns",
    build: async () => {
      throw new Error("boom");
    },
  };

  it("appear only for a plan that includes them", async () => {
    const care = await client("Care Co");
    const growth = await client("Growth Co", { plan: "growth" });

    const careData = await buildReportData(db, await subjectFor(care), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [reviews] });
    const growthData = await buildReportData(db, await subjectFor(growth), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [reviews] });

    expect(careData.extras).toEqual([]);
    expect(growthData.extras).toEqual([
      { key: "reviews", title: "Google reviews", state: "ok", headline: "4 new reviews", rows: [{ label: "New reviews", value: "4" }], note: null },
    ]);
  });

  it("that throw become a missing section, and the report still builds", async () => {
    const growth = await client("Growth broken", { plan: "growth" });
    const data = await buildReportData(db, await subjectFor(growth), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [broken, reviews] });
    expect(data.extras.map((e) => [e.key, e.state])).toEqual([
      ["campaigns", "missing"],
      ["reviews", "ok"],
    ]);
  });
});

describe("the scheduled run", () => {
  it("does nothing after the first week of the month", async () => {
    const result = await runScheduledMonthlyReports(db, { now: new Date("2026-10-14T18:00:00.000Z"), extensions: [] });
    expect(result).toEqual({ ran: false, reason: "not_due" });
  });

  it("builds last month's report for Care clients and emails each once", async () => {
    await db.delete(monthlyReports);
    // Only the clients this test makes should be due: retire everyone else.
    await db.update(clients).set({ archivedAt: new Date() });

    const care = await client("Due Co");
    await site(care);
    const lite = await client("Lite Due", { plan: "lite" });
    const demo = await client("Demo Due", { isDemo: true });
    const late = await client("Late Starter", { startedOn: "2026-10-01" });
    const none = await client("No Plan", { plan: null });

    const first = await runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(first).toMatchObject({ ran: true, period: "2026-09", built: 1, emailed: 1, failed: 0, remaining: 0 });

    const reports = await db.select().from(monthlyReports);
    expect(reports.map((r) => r.organizationId)).toEqual([care.organizationId]);
    expect(reports[0]).toMatchObject({ emailStatus: "sent" });
    expect(sent).toHaveLength(1);
    // To the client's own portal user.
    expect(sent[0]!.to).toMatch(/^due-co-[a-z0-9]+@example\.test$/);
    expect(sent[0]!.subject).toContain("September 2026");
    expect(sent[0]!.text).toContain("https://portal.example.test/dashboard/reports/2026-09");
    // Missing stated as missing, in the email too.
    expect(sent[0]!.text).toContain("Visitors: Analytics not connected yet");

    // A second tick the same day changes nothing and sends nothing.
    const second = await runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(second).toEqual({ ran: false, reason: "none_due" });
    expect(sent).toHaveLength(1);

    for (const skipped of [lite, demo, late, none]) {
      expect(reports.some((r) => r.organizationId === skipped.organizationId)).toBe(false);
    }
  });

  it("sends one email when two runs build the same report at once", async () => {
    await db.delete(monthlyReports);
    await db.update(clients).set({ archivedAt: new Date() });
    const care = await client("Race Co");

    const results = await Promise.all([
      runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, extensions: [] }),
      runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, extensions: [] }),
    ]);
    const built = results.reduce((sum, r) => sum + (r.ran ? r.built : 0), 0);
    expect(built).toBe(1);
    expect(sent.filter((m) => m.subject.includes("September"))).toHaveLength(1);
    expect(await db.select().from(monthlyReports).where(eq(monthlyReports.organizationId, care.organizationId))).toHaveLength(1);
  });

  it("builds but does not email a client who opted out", async () => {
    await db.delete(monthlyReports);
    await db.update(clients).set({ archivedAt: new Date() });
    const quiet = await client("Quiet Co");
    await setMyReportEmails(db, quiet.ctx, false);

    const result = await runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, extensions: [] });
    expect(result).toMatchObject({ ran: true, built: 1, emailed: 0 });
    const [row] = await db.select().from(monthlyReports).where(eq(monthlyReports.organizationId, quiet.organizationId));
    expect(row).toMatchObject({ emailStatus: "opted_out", emailedAt: null });
    expect(sent).toHaveLength(0);
  });

  it("works through a backlog a batch at a time", async () => {
    await db.delete(monthlyReports);
    await db.update(clients).set({ archivedAt: new Date() });
    for (const name of ["One", "Two", "Three"]) await client(`Batch ${name}`);

    const first = await runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, batch: 2, extensions: [] });
    expect(first).toMatchObject({ ran: true, built: 2, remaining: 1 });
    const second = await runScheduledMonthlyReports(db, { now: FIRST_OF_OCTOBER, batch: 2, extensions: [] });
    expect(second).toMatchObject({ ran: true, built: 1, remaining: 0 });
  });
});

describe("the client's side", () => {
  it("lists and opens only their own reports", async () => {
    const acme = await client("Acme Iso");
    const globex = await client("Globex Iso");
    const data = await buildReportData(db, await subjectFor(acme), "2026-09", { now: FIRST_OF_OCTOBER, extensions: [] });
    await saveReport(db, acme.organizationId, data, { now: FIRST_OF_OCTOBER });

    expect((await listMyReports(db, acme.ctx)).map((r) => r.period)).toEqual(["2026-09"]);
    expect(await listMyReports(db, globex.ctx)).toEqual([]);
    expect(await getMyReport(db, globex.ctx, "2026-09")).toEqual({ found: false });
    expect(await getMyReport(db, acme.ctx, "2026-09")).toMatchObject({ found: true, data: { period: "2026-09" } });
    expect(await getMyReport(db, acme.ctx, "../../x")).toEqual({ found: false });
  });

  it("knows whether their plan includes the report", async () => {
    expect(await hasMonthlyReport(db, (await client("Care Has")).ctx)).toBe(true);
    expect(await hasMonthlyReport(db, (await client("Lite Has", { plan: "lite" })).ctx)).toBe(false);
  });

  it("can turn the email off and on, but not while an operator views as them", async () => {
    const acme = await client("Acme Toggle");
    expect(await getMyReportEmails(db, acme.ctx)).toEqual({ on: true });
    await setMyReportEmails(db, acme.ctx, false);
    expect(await getMyReportEmails(db, acme.ctx)).toEqual({ on: false });
    await setMyReportEmails(db, acme.ctx, true);
    expect(await getMyReportEmails(db, acme.ctx)).toEqual({ on: true });

    const viewing = tenantContextFrom(
      { userId: acme.userId, organizationId: acme.organizationId, role: "admin", status: "active", sessionEpoch: 0 },
      acme.organizationId,
      { impersonating: true },
    );
    await expect(setMyReportEmails(db, viewing, false)).rejects.toThrow(/read-only/);
  });
});

describe("the operator's side", () => {
  it("rebuilds without emailing, and refuses a month that isn't over", async () => {
    const acme = await client("Acme Admin");
    const ctx = adminCtx(acme);
    const done = await rebuildClientReport(ctx, db, acme.publicId, "2026-09", FIRST_OF_OCTOBER);
    expect(done.ok).toBe(true);
    expect(sent).toHaveLength(0);

    const early = await rebuildClientReport(ctx, db, acme.publicId, "2026-10", FIRST_OF_OCTOBER);
    expect(early).toMatchObject({ ok: false });
  });

  it("previews exactly the email the client will get, then re-sends it", async () => {
    const acme = await client("Acme Preview");
    const ctx = adminCtx(acme);
    await rebuildClientReport(ctx, db, acme.publicId, "2026-09", FIRST_OF_OCTOBER);

    const preview = await getClientReportPreview(ctx, db, acme.publicId, "2026-09");
    expect(preview?.email?.subject).toContain("September 2026");
    expect(preview?.recipients).toHaveLength(1);

    expect(await resendClientReport(ctx, db, acme.publicId, "2026-09")).toMatchObject({ ok: true });
    expect(await resendClientReport(ctx, db, acme.publicId, "2026-09")).toMatchObject({ ok: true });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe(preview!.email!.subject);
  });

  it("will not re-send to a client who opted out", async () => {
    const acme = await client("Acme Opted");
    const ctx = adminCtx(acme);
    await rebuildClientReport(ctx, db, acme.publicId, "2026-09", FIRST_OF_OCTOBER);
    await setClientReportEmails(ctx, db, acme.publicId, false);

    expect(await resendClientReport(ctx, db, acme.publicId, "2026-09")).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
    expect(await getMyReportEmails(db, acme.ctx)).toEqual({ on: false });
  });
});
