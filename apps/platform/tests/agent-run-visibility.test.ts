import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import { agentJobs, sites } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import { listAllChangeRequests } from "@/db/repositories/admin/clients";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The "Run" column on the operator queue.
 *
 * It answers the only question an operator has about a request in flight — has
 * the agent got this, is it still going, where is the pull request — and it is
 * built from three correlated subqueries against the latest job. Nothing
 * covered them, and a subquery that silently returns null looks exactly like a
 * request nobody has started.
 */

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
  ctx = adminContextFrom({
    userId: acme.userId,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
});

afterAll(async () => {
  await close();
});

async function requestWithJob(title: string, job: Record<string, unknown>) {
  const site = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      name: `acme.test/${title}`,
    })
    .returning({ publicId: sites.publicId });

  const created = await createChangeRequest(db, acme.ctx, {
    title,
    sitePublicId: site[0]!.publicId,
  });

  await db.insert(agentJobs).values({
    publicId: newPublicId(),
    requestId: created.id,
    status: "pr_open",
    ...job,
  });

  return created.publicId;
}

describe("what the operator queue reports about a run", () => {
  it("shows when the agent was handed the request", async () => {
    const dispatchedAt = new Date("2026-09-09T10:00:00Z");
    const publicId = await requestWithJob("Dispatched change", { dispatchedAt });

    const rows = await listAllChangeRequests(ctx, db, { limit: 200 });
    const row = rows.find((r) => r.publicId === publicId)!;

    // Null here is indistinguishable on screen from "nobody has started it",
    // which is the wrong answer for a run already under way.
    expect(row.agentDispatchedAt).not.toBeNull();
    expect(new Date(row.agentDispatchedAt!).toISOString()).toBe(
      dispatchedAt.toISOString(),
    );
  });

  it("shows the pull request once there is one", async () => {
    const url = "https://github.com/cjackmort/mortensenweb/pull/9";
    const publicId = await requestWithJob("Change with a PR", {
      dispatchedAt: new Date("2026-09-09T11:00:00Z"),
      prUrl: url,
    });

    const rows = await listAllChangeRequests(ctx, db, { limit: 200 });
    const row = rows.find((r) => r.publicId === publicId)!;

    expect(row.agentPrUrl).toBe(url);
  });

  it("reports the latest attempt, not the first", async () => {
    const site = await db
      .insert(sites)
      .values({
        publicId: newPublicId(),
        organizationId: acme.organizationId,
        name: "acme.test/redispatched",
      })
      .returning({ publicId: sites.publicId });

    const created = await createChangeRequest(db, acme.ctx, {
      title: "Re-dispatched change",
      sitePublicId: site[0]!.publicId,
    });

    const older = new Date("2026-09-01T10:00:00Z");
    const newer = new Date("2026-09-08T10:00:00Z");

    await db.insert(agentJobs).values({
      publicId: newPublicId(),
      requestId: created.id,
      status: "failed",
      dispatchedAt: older,
      createdAt: older,
      prUrl: "https://github.com/cjackmort/mortensenweb/pull/1",
    });
    await db.insert(agentJobs).values({
      publicId: newPublicId(),
      requestId: created.id,
      status: "pr_open",
      dispatchedAt: newer,
      createdAt: newer,
      prUrl: "https://github.com/cjackmort/mortensenweb/pull/2",
    });

    const rows = await listAllChangeRequests(ctx, db, { limit: 200 });
    const row = rows.find((r) => r.publicId === created.publicId)!;

    expect(row.agentPrUrl).toBe(
      "https://github.com/cjackmort/mortensenweb/pull/2",
    );
    expect(new Date(row.agentDispatchedAt!).toISOString()).toBe(
      newer.toISOString(),
    );
  });

  it("leaves a request nobody has started reporting nothing", async () => {
    const site = await db
      .insert(sites)
      .values({
        publicId: newPublicId(),
        organizationId: acme.organizationId,
        name: "acme.test/untouched",
      })
      .returning({ publicId: sites.publicId });

    const created = await createChangeRequest(db, acme.ctx, {
      title: "Nobody has started this",
      sitePublicId: site[0]!.publicId,
    });

    const rows = await listAllChangeRequests(ctx, db, { limit: 200 });
    const row = rows.find((r) => r.publicId === created.publicId)!;

    expect(row.agentDispatchedAt).toBeNull();
    expect(row.agentPrUrl).toBeNull();
  });
});
