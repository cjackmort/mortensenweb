import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agentJobs, changeRequests, sites } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import {
  expireStalledJobs,
  reclaimStalledRequest,
} from "@/db/repositories/admin/agent-jobs";
import { listAllChangeRequests } from "@/db/repositories/admin/clients";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Getting a dead agent run out of the way by hand.
 *
 * The watchdog is supposed to do this on the five-minute tick. It stopped, and
 * a request sat on "being worked on" for eight hours with no control anywhere:
 * the queue hides "Start work" once a request is dispatched, and hides "Close"
 * too, because closing would not stop a run genuinely in flight. Right for a
 * live run, a trap for a dead one — and there was no way out of it.
 *
 * Two things have to hold. An operator must be able to release a run the
 * schedule has abandoned, and must *not* be able to yank one that is still
 * inside its timeout, which would leave a live agent writing to a branch
 * nobody is watching.
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

const MINUTE = 60_000;

async function dispatchedRequest(title: string, timeoutInMinutes: number) {
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

  await db
    .update(changeRequests)
    .set({ status: "dispatched" })
    .where(eq(changeRequests.id, created.id));

  await db.insert(agentJobs).values({
    publicId: newPublicId(),
    requestId: created.id,
    status: "dispatched",
    dispatchedAt: new Date(Date.now() - 60 * MINUTE),
    timeoutAt: new Date(Date.now() + timeoutInMinutes * MINUTE),
  });

  return created;
}

async function statusOf(id: string) {
  const rows = await db
    .select({ status: changeRequests.status })
    .from(changeRequests)
    .where(eq(changeRequests.id, id));
  return rows[0]!.status;
}

describe("reclaiming a run the watchdog never got to", () => {
  it("fails an overdue run and releases the request", async () => {
    const request = await dispatchedRequest("Stuck for hours", -30);

    const outcome = await reclaimStalledRequest(ctx, db, request.publicId);

    expect(outcome.ok).toBe(true);
    expect(await statusOf(request.id)).toBe("failed");
  });

  it("marks the job itself timed out, not merely the request", async () => {
    const request = await dispatchedRequest("Job state matters", -30);

    await reclaimStalledRequest(ctx, db, request.publicId);

    const jobs = await db
      .select({ status: agentJobs.status, finishedAt: agentJobs.finishedAt })
      .from(agentJobs)
      .where(eq(agentJobs.requestId, request.id));

    // Left `dispatched`, the job would be picked up again by the watchdog the
    // moment the schedule came back, and the client notified twice.
    expect(jobs[0]!.status).toBe("timed_out");
    expect(jobs[0]!.finishedAt).not.toBeNull();
  });

  it("refuses a run that is still inside its timeout", async () => {
    const request = await dispatchedRequest("Genuinely running", 30);

    const outcome = await reclaimStalledRequest(ctx, db, request.publicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_overdue");
    // Untouched: a live agent is still writing to its branch.
    expect(await statusOf(request.id)).toBe("dispatched");
  });

  it("refuses a request that never had a run", async () => {
    const site = await db
      .insert(sites)
      .values({
        publicId: newPublicId(),
        organizationId: acme.organizationId,
        name: "acme.test/no-run",
      })
      .returning({ publicId: sites.publicId });
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Never dispatched",
      sitePublicId: site[0]!.publicId,
    });

    const outcome = await reclaimStalledRequest(ctx, db, created.publicId);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_found");
  });

  it("does the same thing the watchdog would have done", async () => {
    const byHand = await dispatchedRequest("Reclaimed by a person", -30);
    const bySchedule = await dispatchedRequest("Reclaimed by the tick", -30);

    await reclaimStalledRequest(ctx, db, byHand.publicId);
    await expireStalledJobs(db);

    // The manual path is used exactly when the automatic one is broken, which
    // is the worst moment to discover the two disagree.
    expect(await statusOf(byHand.id)).toBe(await statusOf(bySchedule.id));
  });

  it("flags an overdue run to the queue, which is how the operator sees it", async () => {
    const overdue = await dispatchedRequest("Late run", -30);
    const healthy = await dispatchedRequest("On time", 30);

    const rows = await listAllChangeRequests(ctx, db, { limit: 200 });

    expect(rows.find((r) => r.publicId === overdue.publicId)!.agentOverdue).toBe(
      true,
    );
    expect(rows.find((r) => r.publicId === healthy.publicId)!.agentOverdue).toBe(
      false,
    );
  });

  it("stops flagging it once it has been reclaimed", async () => {
    const request = await dispatchedRequest("Late then handled", -30);

    await reclaimStalledRequest(ctx, db, request.publicId);
    const rows = await listAllChangeRequests(ctx, db, { limit: 200 });

    expect(
      rows.find((r) => r.publicId === request.publicId)!.agentOverdue,
    ).toBe(false);
  });
});
