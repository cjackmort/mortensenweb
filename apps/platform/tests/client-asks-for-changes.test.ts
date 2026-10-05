import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  clients,
  dispatchQuotas,
  organizationMemberships,
  organizations,
  repositoryConnections,
  requestEvents,
  sites,
  users,
} from "@/db/schema";
import { adminContextFrom, tenantContextFrom } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * A client looks at a preview and asks for changes: the agent starts again.
 *
 * Before this, "Ask for changes" recorded the client's note and moved the
 * request to `changes_requested` — a status nothing dispatched from. The client
 * was told "we'll make those adjustments" and nothing happened until someone
 * noticed. It now goes the same way an operator's "Hold it back" does: the
 * agent redoes the change from that preview with the client's notes, and the
 * new preview comes to the operator to check before the client sees it.
 */

const issues: { title: string; body: string }[] = [];
const closedPullRequests: number[] = [];
const sent: { to: string; subject: string }[] = [];

vi.mock("@/lib/github/rest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/rest")>();
  return {
    ...actual,
    createIssue: async (_repo: unknown, input: { title: string; body: string }) => {
      issues.push(input);
      const number = 200 + issues.length;
      return { number, html_url: `https://github.com/agency/acme/issues/${number}`, node_id: `I_${number}` };
    },
    commentOnIssue: async () => {},
    getPullRequest: async (_repo: unknown, number: number) => ({
      number,
      state: "open",
      draft: false,
      merged: false,
      mergeable_state: "clean",
      html_url: "",
      title: "",
      head: { sha: "abc123", ref: "portal/21-hero" },
      base: { ref: "main" },
      user: null,
    }),
    closePullRequest: async (_repo: unknown, number: number) => {
      closedPullRequests.push(number);
      return { closed: true, status: 200 };
    },
    deleteBranch: async () => ({ deleted: true, status: 204 }),
  };
});

vi.mock("@/lib/email/mailer", () => ({
  sendEmail: async (message: { to: string; subject: string }) => {
    sent.push({ to: message.to, subject: message.subject });
    return { status: "sent", id: `msg_${sent.length}` };
  },
}));

const { recordPreviewDecision } = await import("@/db/repositories/client/previews");
const { redoAfterClientChanges, redoChangesRequested } = await import(
  "@/db/repositories/admin/revisions"
);
const { releasePreview } = await import("@/db/repositories/admin/release");

const NOTE = "Can the sculpture be a little bigger, and the background lighter?";

let db: Database;
let close: () => Promise<void>;
let orgId: string;
let adminId: string;
let ownerId: string;
let requestId: string;
let requestPublicId: string;
let firstJobPublicId: string;

function owner() {
  return tenantContextFrom(
    { userId: ownerId, organizationId: orgId, role: "client", status: "active", sessionEpoch: 0 },
    orgId,
  );
}

function admin() {
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
  closedPullRequests.length = 0;
  sent.length = 0;
  process.env.GITHUB_APP_ID = "test-app";
  process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-key";

  for (const table of [auditLog, requestEvents, agentJobs, dispatchQuotas, changeRequests, repositoryConnections, sites, clients, organizationMemberships, users, organizations]) {
    await db.delete(table);
  }

  orgId = (
    await db.insert(organizations).values({ publicId: newPublicId(), name: "Acme", slug: "acme", kind: "client" }).returning()
  )[0]!.id;
  adminId = (
    await db.insert(users).values({ publicId: newPublicId(), email: "admin@agency.test", role: "admin", status: "active" }).returning()
  )[0]!.id;
  ownerId = (
    await db.insert(users).values({ publicId: newPublicId(), email: "owner@acme.test", role: "client", status: "active" }).returning()
  )[0]!.id;
  await db.insert(organizationMemberships).values({ organizationId: orgId, userId: ownerId, role: "owner" as never });
  await db.insert(clients).values({ publicId: newPublicId(), organizationId: orgId, primaryContactEmail: "contact@acme.test" });

  const site = (
    await db.insert(sites).values({ publicId: newPublicId(), organizationId: orgId, name: "Acme", netlifySiteName: "acme" }).returning()
  )[0]!;
  const connection = (
    await db
      .insert(repositoryConnections)
      .values({
        publicId: newPublicId(),
        siteId: site.id,
        owner: "agency",
        name: "acme",
        repoNodeId: `R_${Math.random().toString(36).slice(2, 12)}`,
        installationId: "12345",
        defaultBranch: "main",
        allowlisted: true,
      })
      .returning()
  )[0]!;

  const request = (
    await db
      .insert(changeRequests)
      .values({ publicId: newPublicId(), organizationId: orgId, siteId: site.id, title: "Hero image", category: "content", priority: "normal", status: "pr_open" })
      .returning()
  )[0]!;
  requestId = request.id;
  requestPublicId = request.publicId;

  // A preview the operator has already checked and handed to the client.
  firstJobPublicId = newPublicId();
  await db.insert(agentJobs).values({
    publicId: firstJobPublicId,
    requestId,
    repositoryConnectionId: connection.id,
    baseRef: "main",
    status: "pr_open",
    issueNumber: 21,
    prNumber: 22,
    headSha: "abc123",
    previewUrl: "https://deploy-preview-22--acme.netlify.app",
    previewVerifiedAt: new Date(),
    operatorReleasedAt: new Date(),
    operatorReleasedBy: adminId,
  });
});

afterEach(() => {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.AGENT_AUTO_DISPATCH;
});

async function jobs() {
  return db.select().from(agentJobs).where(eq(agentJobs.requestId, requestId));
}

async function requestStatus() {
  return (await db.select().from(changeRequests).where(eq(changeRequests.id, requestId)))[0]!.status;
}

describe("asking for changes", () => {
  it("needs to say what should be different", async () => {
    const outcome = await recordPreviewDecision(db, owner(), requestPublicId, "changes_requested", "   ");

    expect(outcome.ok).toBe(false);
    expect(await requestStatus()).toBe("pr_open");
  });

  it("starts the agent again from that preview, with the client's notes", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    await recordPreviewDecision(db, owner(), requestPublicId, "changes_requested", NOTE);

    const ran = await redoChangesRequested(db);

    expect(ran).toEqual({ dispatched: 1, refused: 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain(NOTE);
    expect(issues[0]!.body).toContain("pull/22/head");

    const all = await jobs();
    expect(all.find((j) => j.publicId === firstJobPublicId)!.status).toBe("cancelled");
    expect(all.find((j) => j.publicId !== firstJobPublicId)!.status).toBe("dispatched");
    expect(await requestStatus()).toBe("dispatched");
    expect(closedPullRequests).toEqual([22]);
  });

  it("tells the client their changes are under way", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    await recordPreviewDecision(db, owner(), requestPublicId, "changes_requested", NOTE);
    await redoChangesRequested(db);

    const started = await db
      .select()
      .from(requestEvents)
      .where(and(eq(requestEvents.requestId, requestId), eq(requestEvents.kind, "work_started")));
    expect(started).toHaveLength(1);
    expect(started[0]!.visibility).toBe("client_visible");
  });

  it("waits for the operator when automatic work is switched off", async () => {
    await recordPreviewDecision(db, owner(), requestPublicId, "changes_requested", NOTE);

    expect(await redoChangesRequested(db)).toEqual({ dispatched: 0, refused: 0 });
    expect(issues).toHaveLength(0);
    expect(await requestStatus()).toBe("changes_requested");

    // The operator's own button does the same thing by hand.
    const outcome = await redoAfterClientChanges(db, requestPublicId, { automatic: false, userId: adminId });
    expect(outcome.ok).toBe(true);
    expect(issues[0]!.body).toContain(NOTE);
  });

  it("starts nothing for a request the client has not sent back", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";

    const outcome = await redoAfterClientChanges(db, requestPublicId, { automatic: true });

    expect(outcome.ok).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it("emails the client about the new preview, though they had one before", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    // The first preview was announced when it was released.
    await db.update(agentJobs).set({ operatorReleasedAt: null }).where(eq(agentJobs.publicId, firstJobPublicId));
    await releasePreview(admin(), db, firstJobPublicId);
    expect(sent).toHaveLength(1);

    await recordPreviewDecision(db, owner(), requestPublicId, "changes_requested", NOTE);
    await redoChangesRequested(db);

    // The redo's pull request opens and its preview builds.
    const redo = (await jobs()).find((j) => j.publicId !== firstJobPublicId)!;
    await db
      .update(agentJobs)
      .set({ status: "pr_open", prNumber: 30, previewUrl: "https://deploy-preview-30--acme.netlify.app", previewVerifiedAt: new Date() })
      .where(eq(agentJobs.id, redo.id));
    await db.update(changeRequests).set({ status: "pr_open" }).where(eq(changeRequests.id, requestId));

    const released = await releasePreview(admin(), db, redo.publicId);
    expect(released.ok).toBe(true);
    expect(sent).toHaveLength(2);
  });
});
