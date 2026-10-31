import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  analyticsConnections,
  auditLog,
  businessProfiles,
  clients,
  conceptJobs,
  conceptRepositories,
  organizationMemberships,
  organizations,
  previewDeployments,
  prospectContacts,
  prospectConversions,
  prospects,
  repositoryConnections,
  sites,
  users,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import type { createGithubFake } from "./helpers/github-fake";

/**
 * Converting a potential client, end to end, against a real database.
 *
 * Mocked only at the edges — `githubRequest`, the Netlify calls the leads
 * inbox makes, Umami's provisioning, the mailer and the secret sealing — so
 * every repository function the admin buttons use runs for real.
 */

const WEBSITE_ID = "8b6f2a0e-3c4d-4e5f-9a1b-2c3d4e5f6a7b";
const REPO = "cjackmort/concept-basin-view-abc123";

const github: { fake: ReturnType<typeof createGithubFake> | null } = { fake: null };
const sent: { to: string; subject: string; text: string }[] = [];
const umami = { fail: false };

vi.mock("@/lib/github/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/app")>();
  const { createGithubFake } = await import("./helpers/github-fake");
  github.fake = createGithubFake(actual.GithubApiError);
  return {
    ...actual,
    isGithubConfigured: () => true,
    githubRequest: (...args: Parameters<typeof actual.githubRequest>) =>
      github.fake!.request(...(args as [string, string, never])),
  };
});

vi.mock("@/lib/github/secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/secrets")>();
  return {
    ...actual,
    provisionRepoSecrets: async () => ({
      written: ["CLAUDE_CODE_OAUTH_TOKEN", "NETLIFY_AUTH_TOKEN"],
      missing: [],
      failed: [],
    }),
  };
});

vi.mock("@/lib/netlify/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/netlify/api")>();
  return {
    ...actual,
    isNetlifyConfigured: () => true,
    connectFormsWebhook: async () => ({ hookId: "hook_1" }),
    listFormSubmissions: async () => [],
  };
});

vi.mock("@/lib/analytics/umami", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/umami")>();
  return {
    ...actual,
    provisionWebsite: async () =>
      umami.fail
        ? { ok: false, reason: "failed", message: "Umami responded 503 when creating the website." }
        : { ok: true, websiteId: WEBSITE_ID, created: true },
  };
});

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    sent.push(message);
    return { status: "sent", id: "email_1" };
  },
}));

const { convertProspect, readConversion } = await import("@/db/repositories/admin/conversion");
const { listPotentialClients } = await import("@/db/repositories/admin/potential-clients");
const { DEPLOY_CALLER_WORKFLOW } = await import("@/lib/github/deploy-workflow");
const { AGENT_CALLER_WORKFLOW } = await import("@/lib/github/agent-workflow");
const { adminContextFrom } = await import("@/db/repositories/context");

const SITE_JSON = {
  meta: {
    businessName: "Basin View Designs",
    tagline: "Wedding and event florals in the Bighorn Basin",
    domain: "basinviewdesigns.com",
  },
  seo: { description: "Florals", serviceArea: ["Cody", "Powell", "Worland"] },
  brand: { colorPrimary: "#4a6b3a", fontHeading: "'Fraunces', serif" },
  contact: {
    phone: "(307) 555-2100",
    email: "hello@basinviewdesigns.com",
    address: { street: "12 Sheridan Ave", city: "Cody", state: "WY", zip: "82414" },
    hours: [
      { days: "Tue-Sat", open: "10:00 AM", close: "5:00 PM" },
      { days: "Sun", open: "By appointment", close: "" },
    ],
    social: { facebook: "", instagram: "https://instagram.com/basinviewdesigns", google: "" },
  },
  services: [{ title: "Wedding florals" }, { title: "Event installs" }],
  analytics: { umamiWebsiteId: "copied-from-the-reference-site", umamiScriptUrl: "" },
  booking: { enabled: true, portal: { baseUrl: "https://portal.mortensenweb.com", siteId: "OLDSITE" } },
  shop: { enabled: false, portalBaseUrl: "https://portal.mortensenweb.com", siteId: "" },
};

let db: Database;
let close: () => Promise<void>;
let adminId: string;

function ctx() {
  return adminContextFrom({
    userId: adminId,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
}

async function seedProspect({
  withConcept = true,
  siteJson = SITE_JSON as unknown,
}: { withConcept?: boolean; siteJson?: unknown } = {}) {
  const prospectPublicId = newPublicId();
  const [prospect] = await db
    .insert(prospects)
    .values({
      publicId: prospectPublicId,
      businessName: "Basin View Designs",
      industry: "florist",
      status: "concept_pending",
    })
    .returning();
  await db.insert(prospectContacts).values({
    prospectId: prospect!.id,
    name: "Dana",
    email: "dana@basinview.test",
    phone: "307-555-2100",
  });

  if (!withConcept) return { prospectPublicId };

  const [org] = await db
    .insert(organizations)
    .values({
      publicId: newPublicId(),
      name: "Basin View Designs",
      slug: `prospect-${prospectPublicId.slice(0, 10).toLowerCase()}`,
      kind: "client",
    })
    .returning();
  const [site] = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: org!.id,
      name: "Basin View Designs",
      status: "draft",
      netlifySiteId: "nf-site-1",
      netlifySiteName: "concept-basin-view-abc123",
    })
    .returning();
  await db.insert(repositoryConnections).values({
    publicId: newPublicId(),
    siteId: site!.id,
    owner: "cjackmort",
    name: "concept-basin-view-abc123",
    repoNodeId: "R_concept",
    installationId: "123",
    defaultBranch: "main",
  });
  const [job] = await db
    .insert(conceptJobs)
    .values({ publicId: newPublicId(), prospectId: prospect!.id, status: "building", planApprovalRequired: false })
    .returning();
  await db.insert(conceptRepositories).values({
    conceptJobId: job!.id,
    owner: "cjackmort",
    name: "concept-basin-view-abc123",
    visibility: "private",
  });
  await db.insert(previewDeployments).values({
    publicId: newPublicId(),
    conceptJobId: job!.id,
    siteId: site!.id,
    kind: "concept",
    url: "https://concept-basin-view-abc123.netlify.app",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  github.fake!.seedFile(REPO, "main", "src/content/site.json", JSON.stringify(siteJson, null, 2) + "\n");
  github.fake!.seedFile(REPO, "main", ".github/workflows/deploy.yml", "name: old full copy\n");

  return { prospectPublicId, organizationId: org!.id, siteId: site!.id, sitePublicId: site!.publicId };
}

function step(report: { steps: { id: string; status: string; detail: string; carried?: true }[] }, id: string) {
  const found = report.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  process.env.GITHUB_INSTALLATION_ID = "123";
  process.env.AUTH_URL = "https://portal.example.test";
  process.env.NETLIFY_FORMS_WEBHOOK_SECRET = "forms-master-secret-for-tests-only-0123456789";
  process.env.UMAMI_API_BASE_URL = "https://umami.example.test/api";
  process.env.UMAMI_API_KEY = "umami-key";
});

afterAll(async () => close());

beforeEach(async () => {
  github.fake?.reset();
  sent.length = 0;
  umami.fail = false;
  for (const table of [
    auditLog,
    prospectConversions,
    previewDeployments,
    conceptRepositories,
    conceptJobs,
    analyticsConnections,
    repositoryConnections,
    businessProfiles,
    sites,
    clients,
    prospectContacts,
    prospects,
    organizationMemberships,
    users,
    organizations,
  ]) {
    await db.delete(table);
  }
  adminId = (
    await db
      .insert(users)
      .values({ publicId: newPublicId(), email: "op@example.test", role: "admin", status: "active" })
      .returning()
  )[0]!.id;
});

describe("converting a potential client with a concept site", () => {
  it("connects everything and reports each step", async () => {
    const seeded = await seedProspect();

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { report } = outcome;

    expect(report.steps.map((s) => s.id)).toEqual([
      "client", "site", "allowlist", "repo_secrets", "agent_workflow", "deploy_workflow",
      "netlify_site_variable", "leads_inbox", "analytics", "analytics_snippet",
      "business_profile", "site_kinds", "prospect_converted", "client_invite",
      "search_console", "google_calendar", "stripe_connect",
    ]);
    for (const id of [
      "client", "site", "allowlist", "repo_secrets", "agent_workflow", "deploy_workflow",
      "netlify_site_variable", "leads_inbox", "analytics", "business_profile", "site_kinds",
      "prospect_converted",
    ]) {
      expect(step(report, id).status, `${id}: ${step(report, id).detail}`).toBe("ok");
    }
    expect(step(report, "analytics_snippet").status).toBe("manual");
    expect(step(report, "client_invite").status).toBe("skipped");
    expect(step(report, "search_console").status).toBe("manual");
    expect(step(report, "google_calendar").status).toBe("manual");
    expect(step(report, "stripe_connect").status).toBe("skipped");
    expect(report.complete).toBe(true);
    expect(report.sitePublicId).toBe(seeded.sitePublicId);
    expect(report.repository).toBe(REPO);

    // The holding organization became the client's; nothing moved.
    const [org] = await db.select().from(organizations).where(eq(organizations.id, seeded.organizationId!));
    expect(org!.slug).toBe("basin-view-designs");
    const [client] = await db.select().from(clients);
    expect(client!.organizationId).toBe(seeded.organizationId);
    expect(client!.primaryContactEmail).toBe("dana@basinview.test");
    expect(client!.bookingEnabled).toBe(true);
    expect(client!.shopEnabled).toBe(false);
    expect(report.clientId).toBe(client!.publicId);

    const [site] = await db.select().from(sites).where(eq(sites.id, seeded.siteId!));
    expect(site!.status).toBe("preview");
    expect(site!.formsConnectedAt).not.toBeNull();
    const [preview] = await db.select().from(previewDeployments);
    expect(preview!.expiresAt).toBeNull();
    const [connection] = await db.select().from(repositoryConnections);
    expect(connection!.allowlisted).toBe(true);

    // The repository: both callers, the variable, and a pull request for site.json.
    expect(github.fake!.file(REPO, "main", ".github/workflows/deploy.yml")).toBe(DEPLOY_CALLER_WORKFLOW);
    expect(github.fake!.file(REPO, "main", ".github/workflows/claude.yml")).toBe(AGENT_CALLER_WORKFLOW);
    expect(github.fake!.state.variables.get(`${REPO}:NETLIFY_SITE_ID`)).toBe("nf-site-1");
    expect(github.fake!.state.pulls).toHaveLength(1);
    const onBranch = JSON.parse(github.fake!.file(REPO, "portal/connect-site", "src/content/site.json")!);
    expect(onBranch.analytics.umamiWebsiteId).toBe(WEBSITE_ID);
    expect(onBranch.booking.portal.siteId).toBe(seeded.sitePublicId);
    expect(onBranch.shop.siteId).toBe(seeded.sitePublicId);
    // The default branch is untouched until the pull request is merged.
    const onMain = JSON.parse(github.fake!.file(REPO, "main", "src/content/site.json")!);
    expect(onMain.analytics.umamiWebsiteId).toBe("copied-from-the-reference-site");

    const [analytics] = await db.select().from(analyticsConnections);
    expect(analytics!.umamiWebsiteId).toBe(WEBSITE_ID);

    const [profile] = await db.select().from(businessProfiles);
    const details = profile!.details as Record<string, string>;
    expect(details.businessName).toBe("Basin View Designs");
    expect(details.email).toBe("hello@basinviewdesigns.com");
    expect(details.hours).toBe("Tue-Sat 10:00 AM–5:00 PM\nSun By appointment");
    expect(details.bookingUrl).toBe("https://basinviewdesigns.com/book");
    expect(details.instagram).toBe("https://instagram.com/basinviewdesigns");

    const [prospect] = await db.select().from(prospects);
    expect(prospect!.status).toBe("converted");
    expect(await listPotentialClients(ctx(), db)).toEqual([]);
    const [conversion] = await db.select().from(prospectConversions);
    expect(conversion!.convertedBy).toBe(adminId);

    // No email, no sign-in: invite was not asked for.
    expect(sent).toHaveLength(0);
    expect(await db.select().from(organizationMemberships)).toHaveLength(0);
  });

  it("repeats nothing that finished when run again", async () => {
    const seeded = await seedProspect();
    await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    const writesBefore = github.fake!.writes().length;

    const again = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "operator-api" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    expect(step(again.report, "client")).toMatchObject({ status: "ok", carried: true });
    expect(step(again.report, "deploy_workflow")).toMatchObject({ status: "ok", carried: true });
    // The snippet is still waiting on its pull request, and finds the same one.
    expect(step(again.report, "analytics_snippet").status).toBe("manual");
    expect(github.fake!.state.pulls).toHaveLength(1);
    expect(github.fake!.writes().length).toBe(writesBefore);

    expect(await db.select().from(clients)).toHaveLength(1);
    expect(await db.select().from(prospectConversions)).toHaveLength(1);
    const created = await db.select().from(auditLog).where(eq(auditLog.action, "client.created"));
    expect(created).toHaveLength(1);
  });

  it("repeats a finished step when asked to", async () => {
    const seeded = await seedProspect();
    await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    github.fake!.state.variables.clear();

    const again = await convertProspect(ctx(), db, seeded.prospectPublicId, {
      via: "admin",
      rerun: ["netlify_site_variable"],
    });

    if (!again.ok) throw new Error("expected a report");
    expect(step(again.report, "netlify_site_variable")).toMatchObject({ status: "ok" });
    expect(step(again.report, "netlify_site_variable").carried).toBeUndefined();
    expect(step(again.report, "deploy_workflow").carried).toBe(true);
    expect(github.fake!.state.variables.get(`${REPO}:NETLIFY_SITE_ID`)).toBe("nf-site-1");
  });

  it("reports the snippet ok once the pull request is merged", async () => {
    const seeded = await seedProspect();
    await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    const merged = github.fake!.file(REPO, "portal/connect-site", "src/content/site.json")!;
    github.fake!.seedFile(REPO, "main", "src/content/site.json", merged);
    github.fake!.state.pulls.length = 0;

    const again = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    expect(again.ok && step(again.report, "analytics_snippet").status).toBe("ok");
  });

  it("keeps going past a failed step, and finishes it on the next run", async () => {
    const seeded = await seedProspect();
    umami.fail = true;

    const first = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!first.ok) throw new Error("expected a report");
    expect(step(first.report, "analytics")).toMatchObject({
      status: "failed",
      detail: "Umami responded 503 when creating the website.",
    });
    expect(step(first.report, "analytics_snippet").status).toBe("skipped");
    expect(step(first.report, "business_profile").status).toBe("ok");
    expect(first.report.complete).toBe(false);

    umami.fail = false;
    const second = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!second.ok) throw new Error("expected a report");
    expect(step(second.report, "analytics")).toMatchObject({ status: "ok" });
    expect(step(second.report, "analytics").carried).toBeUndefined();
    expect(step(second.report, "analytics_snippet").status).toBe("manual");
    expect(second.report.complete).toBe(true);
  });

  it("reports a provider's refusal on its step instead of failing the run", async () => {
    const seeded = await seedProspect();
    github.fake!.state.failWhen = (call) =>
      call.method === "PUT" && call.path.endsWith("/deploy.yml")
        ? { status: 403, message: "Resource not accessible by integration" }
        : null;

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!outcome.ok) throw new Error("expected a report");
    expect(step(outcome.report, "deploy_workflow")).toMatchObject({
      status: "failed",
      detail: "GitHub request failed (HTTP 403). Resource not accessible by integration",
    });
    expect(step(outcome.report, "netlify_site_variable").status).toBe("ok");
  });

  it("never overwrites General information someone already entered", async () => {
    const seeded = await seedProspect();
    await db.insert(businessProfiles).values({
      organizationId: seeded.organizationId!,
      details: { phone: "307-555-9999", about: "Typed by the client." },
      updatedBy: adminId,
    });

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!outcome.ok) throw new Error("expected a report");

    const [profile] = await db.select().from(businessProfiles);
    const details = profile!.details as Record<string, string>;
    expect(details.phone).toBe("307-555-9999");
    expect(details.about).toBe("Typed by the client.");
    expect(details.email).toBe("hello@basinviewdesigns.com");
    expect(step(outcome.report, "business_profile").detail).toContain("Kept what was already entered for phone");
  });

  it("lets the request decide booking and shop over site.json", async () => {
    const seeded = await seedProspect();
    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, {
      via: "operator-api",
      booking: false,
      shop: true,
    });
    if (!outcome.ok) throw new Error("expected a report");

    const [client] = await db.select().from(clients);
    expect(client!.bookingEnabled).toBe(false);
    expect(client!.shopEnabled).toBe(true);
    expect(step(outcome.report, "stripe_connect").status).toBe("manual");
    expect(step(outcome.report, "google_calendar").status).toBe("skipped");
  });

  it("copies nothing from a site.json that is still the template's demo", async () => {
    const seeded = await seedProspect({
      siteJson: {
        meta: { businessName: "Acme Plumbing & Heating", domain: "acmeplumbing.com" },
        contact: { phone: "(973) 555-0142" },
        booking: { enabled: true },
      },
    });

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!outcome.ok) throw new Error("expected a report");

    expect(step(outcome.report, "business_profile").status).toBe("skipped");
    expect(step(outcome.report, "site_kinds").status).toBe("skipped");
    expect(await db.select().from(businessProfiles)).toHaveLength(0);
    // Named after the Netlify site, since the template's domain is not theirs.
    expect(step(outcome.report, "analytics").detail).toContain("concept-basin-view-abc123.netlify.app");
  });
});

describe("a site.json copied from another business", () => {
  it("copies nothing from it, so their details cannot reach this client's site", async () => {
    const seeded = await seedProspect({
      siteJson: { ...SITE_JSON, meta: { ...SITE_JSON.meta, businessName: "Scott Mortensen Fine Arts", domain: "scottmortensenfinearts.com" } },
    });

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!outcome.ok) throw new Error("expected a report");

    expect(step(outcome.report, "business_profile")).toMatchObject({ status: "skipped" });
    expect(step(outcome.report, "business_profile").detail).toContain('is about "Scott Mortensen Fine Arts"');
    expect(step(outcome.report, "site_kinds").status).toBe("skipped");
    expect(await db.select().from(businessProfiles)).toHaveLength(0);
    // Its domain is not theirs either.
    expect(step(outcome.report, "analytics").detail).toContain("concept-basin-view-abc123.netlify.app");
    // The ids are still written: the repository is this client's, whatever its file says.
    expect(step(outcome.report, "analytics_snippet").status).toBe("manual");
  });
});

describe("the client's sign-in email", () => {
  it("is sent only when invite is true, and the password is never in the report", async () => {
    const seeded = await seedProspect();

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "operator-api", invite: true });
    if (!outcome.ok) throw new Error("expected a report");

    expect(step(outcome.report, "client_invite").status).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("dana@basinview.test");

    const password = /Temporary password:\s+(\S+)/.exec(sent[0]!.text)?.[1];
    expect(password, "the welcome email carries a temporary password").toBeTruthy();
    expect(JSON.stringify(outcome.report)).not.toContain(password!);
    const audit = await db.select().from(auditLog);
    expect(JSON.stringify(audit)).not.toContain(password!);

    // A second run with invite still set does not issue another.
    const again = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "operator-api", invite: true });
    expect(again.ok && step(again.report, "client_invite").carried).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("without a concept site", () => {
  it("creates the client and skips everything that needs a site", async () => {
    const seeded = await seedProspect({ withConcept: false });

    const outcome = await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    if (!outcome.ok) throw new Error("expected a report");

    expect(step(outcome.report, "client").status).toBe("ok");
    for (const id of ["site", "allowlist", "deploy_workflow", "leads_inbox", "analytics", "business_profile"]) {
      expect(step(outcome.report, id).status).toBe("skipped");
    }
    expect(step(outcome.report, "prospect_converted").status).toBe("ok");
    expect(await db.select().from(clients)).toHaveLength(1);
    expect(github.fake!.state.calls).toHaveLength(0);
  });
});

describe("one conversion at a time", () => {
  it("turns away a second run while the first holds the lease", async () => {
    const seeded = await seedProspect();
    await db.insert(auditLog).values({
      actorUserId: adminId,
      action: "prospect.conversion_started",
      entityType: "prospect",
      entityId: seeded.prospectPublicId,
    });

    expect(await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" })).toEqual({
      ok: false,
      reason: "in_progress",
    });
    expect((await readConversion(db, seeded.prospectPublicId)).state).toBe("running");
    expect(await db.select().from(clients)).toHaveLength(0);
  });

  it("reads back the last report", async () => {
    const seeded = await seedProspect();
    expect(await readConversion(db, seeded.prospectPublicId)).toEqual({ state: "not_started", report: null });

    await convertProspect(ctx(), db, seeded.prospectPublicId, { via: "admin" });
    const read = await readConversion(db, seeded.prospectPublicId);
    expect(read.state).toBe("finished");
    expect(read.report?.steps).toHaveLength(17);
  });
});
