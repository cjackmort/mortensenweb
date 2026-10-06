import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  businessProfiles,
  changeRequests,
  dispatchQuotas,
  organizations,
  repositoryConnections,
  requestEvents,
  siteBriefs,
  sites,
  users,
} from "@/db/schema";
import { adminContextFrom } from "@/db/repositories/context";
import { renderIssueBody } from "@/lib/github/issue";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * A client's general information reaches every agent run for their site.
 *
 * Before this, an agent knew only what a request or brief said. Building a
 * site from scratch meant typing the phone number, the hours and the service
 * list into the brief; every later change that touched the footer meant
 * typing them again, or the agent left a placeholder. The profile is entered
 * once and the portal attaches it.
 */

const issues: { title: string; body: string; labels?: string[] }[] = [];

vi.mock("@/lib/github/rest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/rest")>();
  return {
    ...actual,
    createIssue: async (_repo: unknown, input: { title: string; body: string; labels?: string[] }) => {
      issues.push(input);
      const number = 40 + issues.length;
      return { number, html_url: `https://github.com/agency/acme/issues/${number}`, node_id: `I_${number}` };
    },
  };
});

const { saveBusinessProfile, getBusinessProfile } = await import(
  "@/db/repositories/admin/business-profile"
);
const { sendProfileToSite } = await import("@/db/repositories/admin/profile-sync");
const { dispatchChangeRequest } = await import("@/db/repositories/admin/agent-jobs");
const { dispatchBrief } = await import("@/db/repositories/admin/briefs");

const PROFILE = {
  businessName: "Acme Plumbing",
  phone: "(208) 555-0100",
  hours: "Mon–Fri 8am–5pm\nSat 9am–1pm",
};

let db: Database;
let close: () => Promise<void>;
let orgId: string;
let adminId: string;
let siteId: string;
let sitePublicId: string;

function ctx() {
  return adminContextFrom({ userId: adminId, organizationId: null, role: "admin", status: "active", sessionEpoch: 0 });
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => close());

beforeEach(async () => {
  issues.length = 0;
  process.env.GITHUB_APP_ID = "test-app";
  process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-key";

  await db.delete(auditLog);
  await db.delete(requestEvents);
  await db.delete(agentJobs);
  await db.delete(siteBriefs);
  await db.delete(dispatchQuotas);
  await db.delete(changeRequests);
  await db.delete(businessProfiles);
  await db.delete(repositoryConnections);
  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);

  adminId = (
    await db.insert(users).values({ publicId: newPublicId(), email: "admin@agency.test", role: "admin", status: "active" }).returning()
  )[0]!.id;
  orgId = (
    await db.insert(organizations).values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" }).returning()
  )[0]!.id;

  const site = (
    await db.insert(sites).values({ publicId: newPublicId(), organizationId: orgId, name: "Acme", netlifySiteName: "acme" }).returning()
  )[0]!;
  siteId = site.id;
  sitePublicId = site.publicId;

  await db.insert(repositoryConnections).values({
    publicId: newPublicId(),
    siteId,
    owner: "agency",
    name: "acme",
    repoNodeId: `R_${Math.random().toString(36).slice(2, 12)}`,
    installationId: "12345",
    defaultBranch: "main",
    allowlisted: true,
  });
});

afterEach(() => {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
});

async function submittedRequest(title = "Update the footer") {
  return (
    await db
      .insert(changeRequests)
      .values({ publicId: newPublicId(), organizationId: orgId, siteId, title, category: "content", priority: "normal", status: "submitted" })
      .returning()
  )[0]!;
}

describe("saving the general information", () => {
  it("keeps one profile per client, replacing it on each save", async () => {
    await saveBusinessProfile(ctx(), db, orgId, { phone: "208-555-0000" });
    await saveBusinessProfile(ctx(), db, orgId, PROFILE);

    const profile = await getBusinessProfile(db, orgId);
    expect(profile?.details).toEqual(PROFILE);
    expect(await db.select().from(businessProfiles)).toHaveLength(1);
  });

  it("records which fields changed, not their values", async () => {
    await saveBusinessProfile(ctx(), db, orgId, { phone: "208-555-0000", businessName: "Acme Plumbing" });
    await saveBusinessProfile(ctx(), db, orgId, { phone: "(208) 555-0100", businessName: "Acme Plumbing" });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "business_profile.updated"));
    expect(rows.at(-1)!.metadata).toEqual({ changed: ["phone"] });
  });

  it("is empty for a client nobody has filled in", async () => {
    expect(await getBusinessProfile(db, orgId)).toBeNull();
  });
});

describe("every agent run carries it", () => {
  it("attaches it to a change request's issue, fenced, with line breaks kept", async () => {
    await saveBusinessProfile(ctx(), db, orgId, PROFILE);
    const request = await submittedRequest();

    const outcome = await dispatchChangeRequest(ctx(), db, { requestPublicId: request.publicId });

    expect(outcome.ok).toBe(true);
    const body = issues[0]!.body;
    expect(body).toContain("### The business's general information");
    expect(body).toContain("Phone: (208) 555-0100");
    expect(body).toContain("Opening hours:\n  Mon–Fri 8am–5pm\n  Sat 9am–1pm");
    const section = body.indexOf("### The business's general information");
    expect(body.indexOf("CLIENT-TEXT-", section)).toBeGreaterThan(section);
  });

  it("says nothing about it when there is none", async () => {
    const request = await submittedRequest();
    await dispatchChangeRequest(ctx(), db, { requestPublicId: request.publicId });

    expect(issues[0]!.body).not.toContain("general information");
  });

  it("gives a client's site brief the profile as its confirmed details", async () => {
    await saveBusinessProfile(ctx(), db, orgId, PROFILE);
    const briefPublicId = newPublicId();
    await db.insert(siteBriefs).values({
      publicId: briefPublicId,
      organizationId: orgId,
      siteId,
      kind: "discovery",
      status: "submitted",
      features: "A home page and a contact page.",
      submittedAt: new Date(),
    });

    const outcome = await dispatchBrief(ctx(), db, briefPublicId);

    expect(outcome.ok).toBe(true);
    const body = issues[0]!.body;
    expect(body).toContain("Phone: (208) 555-0100");
    expect(body).not.toContain("None have been verified yet");
  });
});

describe("putting it on the site", () => {
  it("opens one change for the whole site and starts the agent on it", async () => {
    await saveBusinessProfile(ctx(), db, orgId, PROFILE);

    const outcome = await sendProfileToSite(ctx(), db, { organizationId: orgId, sitePublicId });

    expect(outcome.ok).toBe(true);
    const [request] = await db.select().from(changeRequests);
    expect(request!.status).toBe("dispatched");
    // Agency setup work, not one of the client's monthly changes.
    expect(request!.billing).toBe("courtesy");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain("Phone: (208) 555-0100");
    expect(issues[0]!.body).toMatch(/structured data/i);

    const profile = await getBusinessProfile(db, orgId);
    expect(profile?.lastAppliedAt).not.toBeNull();
  });

  it("refuses when there is nothing filled in", async () => {
    const outcome = await sendProfileToSite(ctx(), db, { organizationId: orgId, sitePublicId });

    expect(outcome.ok).toBe(false);
    expect(await db.select().from(changeRequests)).toHaveLength(0);
  });

  it("refuses while another change is open on the site", async () => {
    await saveBusinessProfile(ctx(), db, orgId, PROFILE);
    await submittedRequest("Something already in progress");

    const outcome = await sendProfileToSite(ctx(), db, { organizationId: orgId, sitePublicId });

    expect(outcome.ok).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it("refuses a site that belongs to another client", async () => {
    await saveBusinessProfile(ctx(), db, orgId, PROFILE);
    const otherOrg = (
      await db.insert(organizations).values({ publicId: newPublicId(), name: "Other", slug: "other", kind: "client" }).returning()
    )[0]!;
    const otherSite = (
      await db.insert(sites).values({ publicId: newPublicId(), organizationId: otherOrg.id, name: "Other" }).returning()
    )[0]!;

    const outcome = await sendProfileToSite(ctx(), db, { organizationId: orgId, sitePublicId: otherSite.publicId });

    expect(outcome.ok).toBe(false);
    expect(await db.select().from(changeRequests)).toHaveLength(0);
  });
});

describe("rendering", () => {
  it("leaves the section out of an issue with no profile", () => {
    const body = renderIssueBody({
      requestPublicId: newPublicId(),
      agentJobPublicId: newPublicId(),
      title: "x",
      category: "other",
      priority: "normal",
      businessProfile: [],
    });
    expect(body).not.toContain("general information");
  });
});
