import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agentJobs, changeRequests, sites } from "@/db/schema";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import { cancelChangeRequest } from "@/db/repositories/admin/cancel";
import { listPreviewsAwaitingDecision } from "@/db/repositories/client/previews";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * What the "Ready for you to look at" panel is allowed to offer.
 *
 * The panel puts three buttons in front of a client: put it live, ask for
 * changes, cancel. All three only make sense while the request is actually
 * waiting on them. Offering them for a request that is already closed is not
 * cosmetic — every button is a dead end. "Put it live" acts on a change that
 * was called off, and "Cancel this request" answers "this request is already
 * closed", which reads as the portal being broken because from the client's
 * side it is.
 *
 * The panel selects agent jobs, not requests, so nothing about the job row
 * changing hands says the request behind it was settled. That is the gap these
 * tests close: a settled request must leave the panel however it was settled,
 * including by a path that never touched its job.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let siteId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");

  const rows = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      name: "Acme Site",
    })
    .returning({ id: sites.id, publicId: sites.publicId });
  siteId = rows[0]!.publicId;
});

afterAll(async () => {
  await close();
});

/** A request with a built, verified, operator-released preview. */
async function requestAwaitingDecision(title: string) {
  const created = await createChangeRequest(db, acme.ctx, {
    title,
    sitePublicId: siteId,
  });

  await db
    .update(changeRequests)
    .set({ status: "pr_open" })
    .where(eq(changeRequests.id, created.id));

  await db.insert(agentJobs).values({
    publicId: newPublicId(),
    requestId: created.id,
    status: "pr_open",
    previewUrl: `https://preview-${created.id}.example`,
    previewVerifiedAt: new Date(),
    operatorReleasedAt: new Date(),
  });

  return created;
}

describe("previews awaiting a client decision", () => {
  it("offers a preview that is genuinely waiting on the client", async () => {
    const created = await requestAwaitingDecision("Hero image");

    const previews = await listPreviewsAwaitingDecision(db, acme.ctx);

    expect(previews.map((p) => p.requestPublicId)).toContain(created.publicId);
  });

  it("drops it from the panel once the request is cancelled", async () => {
    const created = await requestAwaitingDecision("Changed my mind");

    const outcome = await cancelChangeRequest(db, {
      requestId: created.id,
      actorUserId: acme.userId,
      actorType: "client",
      reason: "No longer needed",
    });
    expect(outcome.ok).toBe(true);

    const previews = await listPreviewsAwaitingDecision(db, acme.ctx);

    expect(previews.map((p) => p.requestPublicId)).not.toContain(
      created.publicId,
    );
  });

  it("drops it even when the job was left open behind the request", async () => {
    // The stuck card in production. However the request came to be closed —
    // an older cancel path, an operator closing it directly, a job that was
    // re-dispatched so the cancel only reached the newest of two — the panel
    // reads the job, and the job still says `pr_open`. The request's own
    // status is the thing that has to be believed.
    const created = await requestAwaitingDecision("An old test request");

    await db
      .update(changeRequests)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(changeRequests.id, created.id));

    const previews = await listPreviewsAwaitingDecision(db, acme.ctx);

    expect(previews.map((p) => p.requestPublicId)).not.toContain(
      created.publicId,
    );
  });

  it("does not offer a decision on a change that already went live", async () => {
    const created = await requestAwaitingDecision("Already shipped");

    // `merged` is past the point of no return: the commit is on the default
    // branch, so "Looks good — put it live" would be a lie and "Cancel" is
    // refused by the server anyway.
    await db
      .update(changeRequests)
      .set({ status: "merged" })
      .where(eq(changeRequests.id, created.id));

    const previews = await listPreviewsAwaitingDecision(db, acme.ctx);

    expect(previews.map((p) => p.requestPublicId)).not.toContain(
      created.publicId,
    );
  });

  it("keeps one tenant's preview out of another's panel", async () => {
    const created = await requestAwaitingDecision("Acme only");
    const globex = await seedTenant(db, "Globex");

    const previews = await listPreviewsAwaitingDecision(db, globex.ctx);

    expect(previews.map((p) => p.requestPublicId)).not.toContain(
      created.publicId,
    );
  });
});
