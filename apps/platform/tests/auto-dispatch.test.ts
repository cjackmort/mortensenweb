import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  dispatchQuotas,
  organizations,
  repositoryConnections,
  requestEvents,
  sites,
  users,
} from "@/db/schema";
import {
  autoDispatchIfEnabled,
  claimDispatchSlot,
  dispatchChangeRequest,
  isAutoDispatchEnabled,
} from "@/db/repositories/admin/agent-jobs";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Dispatching a request without an operator.
 *
 * The flag this covers removes the only human from the path between a client's
 * words and a write to their repository, so the tests that earn their keep are
 * the ones about it being off, and about it changing nothing else:
 *
 *  - unset must mean off, and so must every near-miss value, because the cost
 *    of a wrong answer is unattended automation nobody asked for;
 *  - a refusal must leave the request exactly as submitted, since the client
 *    has already been told their request was received;
 *  - the allowlist, the status guard, and the daily cap must apply to the
 *    automatic path exactly as they do to the operator's.
 *
 * GitHub is not configured in this environment, so a dispatch that got as far
 * as opening an issue would reach the network. Every case here stops at a guard
 * before that point, which is also the only way to assert the guards fire.
 */

const REPO_OWNER = "agency";

let db: Database;
let close: () => Promise<void>;

let requestPublicId: string;
let requestId: string;
let connectionId: string;
let repoName: string;
let adminUserId: string;

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

async function seed() {
  const org = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Acme",
        slug: `acme-${Math.random().toString(36).slice(2, 8)}`,
        kind: "client",
      })
      .returning()
  )[0]!;

  const admin = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: `admin-${Math.random().toString(36).slice(2, 8)}@example.test`,
        role: "admin",
        status: "active",
      })
      .returning()
  )[0]!;

  adminUserId = admin.id;

  const site = (
    await db
      .insert(sites)
      .values({
        publicId: newPublicId(),
        organizationId: org.id,
        name: "Acme",
        netlifySiteName: "acme-abc123",
      })
      .returning()
  )[0]!;

  repoName = `acme-${Math.random().toString(36).slice(2, 8)}`;

  const connection = (
    await db
      .insert(repositoryConnections)
      .values({
        publicId: newPublicId(),
        siteId: site.id,
        owner: REPO_OWNER,
        name: repoName,
        repoNodeId: `R_${Math.random().toString(36).slice(2, 12)}`,
        installationId: "12345",
        defaultBranch: "main",
        allowlisted: true,
      })
      .returning()
  )[0]!;

  connectionId = connection.id;

  const request = (
    await db
      .insert(changeRequests)
      .values({
        publicId: newPublicId(),
        organizationId: org.id,
        siteId: site.id,
        title: "Change the opening hours",
        description: "Please make it 9-5 on weekdays.",
        status: "submitted",
      })
      .returning()
  )[0]!;

  requestId = request.id;
  requestPublicId = request.publicId;
}

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(requestEvents);
  await db.delete(agentJobs);
  await db.delete(dispatchQuotas);
  await db.delete(changeRequests);
  await db.delete(repositoryConnections);
  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);
  await seed();
});

afterEach(() => {
  delete process.env.AGENT_AUTO_DISPATCH;
  delete process.env.AGENT_DAILY_DISPATCH_CAP;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
});

/**
 * Get past `isGithubConfigured` so a later guard is the one that answers.
 *
 * The key is deliberate nonsense: no case here reaches the point of signing
 * anything, and a case that did would fail on import rather than call GitHub.
 */
function configureGithub(): void {
  process.env.GITHUB_APP_ID = "test-app";
  process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-key";
}

/** Nothing was started: no job, no slot spent, and the request as submitted. */
async function expectNothingDispatched(): Promise<void> {
  expect(await db.select().from(agentJobs)).toHaveLength(0);
  expect(await db.select().from(auditLog)).toHaveLength(0);

  const request = (
    await db.select().from(changeRequests).where(eq(changeRequests.id, requestId))
  )[0]!;
  expect(request.status).toBe("submitted");
}

describe("the auto-dispatch flag", () => {
  it("is off when the variable is not set", () => {
    delete process.env.AGENT_AUTO_DISPATCH;
    expect(isAutoDispatchEnabled()).toBe(false);
  });

  it("is off for anything that is not exactly \"true\"", () => {
    // Every one of these is somebody meaning to turn it on. Reading them as
    // enabled would be the friendlier behaviour and the wrong one: the flag
    // authorises unattended repository writes, so it takes the exact word.
    for (const value of ["", "false", "TRUE", "True", "1", "yes", " true "]) {
      process.env.AGENT_AUTO_DISPATCH = value;
      expect(isAutoDispatchEnabled()).toBe(false);
    }

    process.env.AGENT_AUTO_DISPATCH = "true";
    expect(isAutoDispatchEnabled()).toBe(true);
  });

  it("dispatches nothing while it is off, even with everything else ready", async () => {
    delete process.env.AGENT_AUTO_DISPATCH;
    configureGithub();

    const outcome = await autoDispatchIfEnabled(db, requestPublicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("disabled");

    // The repository is connected and allowlisted and the quota is untouched,
    // so the flag is the only thing that refused this.
    expect(await db.select().from(dispatchQuotas)).toHaveLength(0);
    await expectNothingDispatched();
  });
});

describe("automatic dispatch", () => {
  it("refuses without spending a slot when the GitHub App is not configured", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";

    const outcome = await autoDispatchIfEnabled(db, requestPublicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_configured");

    expect(await db.select().from(dispatchQuotas)).toHaveLength(0);
    await expectNothingDispatched();
  });

  it("leaves the request submitted when the site has no connected repository", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    configureGithub();

    await db.delete(repositoryConnections);

    // The client's submission is already saved at the point this runs, so the
    // only acceptable outcome is a refusal that changes nothing about it.
    const outcome = await autoDispatchIfEnabled(db, requestPublicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("no_repository");

    expect(await db.select().from(dispatchQuotas)).toHaveLength(0);
    await expectNothingDispatched();
  });

  it("throws for a request that does not exist", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    configureGithub();

    // The one outcome that is not a returned refusal, and the reason the
    // submission path wraps this call rather than only checking `ok`.
    await expect(autoDispatchIfEnabled(db, newPublicId())).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await expectNothingDispatched();
  });
});

describe("guards on the automatic path", () => {
  it("refuses a repository that is not allowlisted", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    configureGithub();

    await db
      .update(repositoryConnections)
      .set({ allowlisted: false })
      .where(eq(repositoryConnections.id, connectionId));

    const outcome = await autoDispatchIfEnabled(db, requestPublicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_allowlisted");

    // The opt-in is per repository and is not implied by turning automation on
    // globally, which is the whole reason it is a separate switch.
    expect(await db.select().from(dispatchQuotas)).toHaveLength(0);
    await expectNothingDispatched();
  });

  it("refuses a request that has already been dispatched", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    configureGithub();

    await db
      .update(changeRequests)
      .set({ status: "dispatched" })
      .where(eq(changeRequests.id, requestId));

    const outcome = await autoDispatchIfEnabled(db, requestPublicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("wrong_status");

    expect(await db.select().from(agentJobs)).toHaveLength(0);
    expect(await db.select().from(dispatchQuotas)).toHaveLength(0);
  });

  it("still caps the day at the configured number of dispatches", async () => {
    process.env.AGENT_AUTO_DISPATCH = "true";
    process.env.AGENT_DAILY_DISPATCH_CAP = "1";
    configureGithub();

    // The day's one slot went to an earlier dispatch of some other request.
    const earlier = await claimDispatchSlot(db, `${REPO_OWNER}/${repoName}`);
    expect(earlier.granted).toBe(true);

    const outcome = await autoDispatchIfEnabled(db, requestPublicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("quota_exhausted");

    // Submitting is not a way around the cap. The cap bounds Actions minutes on
    // private repositories, and a client can submit as often as their allowance
    // permits, so a cap the automatic path ignored would not be a cap.
    const quotas = await db.select().from(dispatchQuotas);
    expect(quotas).toHaveLength(1);
    expect(quotas[0]!.count).toBe(1);

    await expectNothingDispatched();
  });
});

describe("the operator's path", () => {
  it("refuses on exactly the same grounds after the refactor", async () => {
    configureGithub();

    const ctx = adminContextFrom({
      userId: adminUserId,
      organizationId: null,
      role: "admin",
      status: "active",
      sessionEpoch: 0,
    });

    await db
      .update(repositoryConnections)
      .set({ allowlisted: false })
      .where(eq(repositoryConnections.id, connectionId));

    // The admin route is unaffected by the flag: it is an instruction, not an
    // automatic dispatch, and it refuses here for the repository's sake.
    delete process.env.AGENT_AUTO_DISPATCH;

    const outcome = await dispatchChangeRequest(ctx, db, { requestPublicId });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_allowlisted");

    await expectNothingDispatched();
  });
});
