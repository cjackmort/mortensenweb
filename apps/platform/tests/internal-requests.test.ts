import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { agentJobs, changeRequests, clients, sites } from "@/db/schema";
import { adminContextFrom, type AdminContext } from "@/db/repositories/context";
import {
  createInternalChangeRequest,
  dispatchInternalChangeRequest,
  listInternalChangeRequests,
} from "@/db/repositories/admin/internal-requests";
import { listAllChangeRequests } from "@/db/repositories/admin/clients";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The agency's own requests, and the queue they are deliberately kept out of.
 *
 * `listAllChangeRequests` filters the internal client out of the operator queue
 * on purpose: mixing the agency's own site work into the client queue is what
 * the MortensenWeb tab exists to avoid. That is a good rule with one
 * consequence nobody covered — **whatever the operator queue hides, the
 * internal tab has to be able to act on.**
 *
 * It could not. The tab offered submit and cancel and nothing else, so a
 * request raised on the agency's own site could be created and called off but
 * never started. The only thing that would move it was `AGENT_AUTO_DISPATCH`,
 * which is off by default and is the unattended path rather than the deliberate
 * one. It sat at `submitted`, indistinguishable on screen from a run already
 * under way.
 */

let db: Database;
let close: () => Promise<void>;
let ctx: AdminContext;
let internalOrgId: string;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());

  const agency = await seedTenant(db, "Mortensen Web");
  internalOrgId = agency.organizationId;
  await db
    .update(clients)
    .set({ isInternal: true })
    .where(eq(clients.organizationId, internalOrgId));

  // A real client, so the queue assertions are about the filter rather than
  // about an empty table.
  acme = await seedTenant(db, "Acme");
  const acmeSite = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: acme.organizationId,
      name: "acme.test",
    })
    .returning({ publicId: sites.publicId });
  await createChangeRequest(db, acme.ctx, {
    title: "A paying client's request",
    sitePublicId: acmeSite[0]!.publicId,
  });

  ctx = adminContextFrom({
    userId: agency.userId,
    organizationId: null,
    role: "admin",
    status: "active",
    sessionEpoch: 0,
  });
});

afterAll(async () => {
  await close();
});

/**
 * A request on a site of its own.
 *
 * One open request per site is the same rule clients get, so each case needs
 * its own site rather than reusing one and tripping over the previous test's
 * still-open request.
 */
async function newInternalRequest(title: string) {
  const site = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: internalOrgId,
      name: `mortensenweb.com/${title}`,
    })
    .returning({ publicId: sites.publicId });

  const created = await createInternalChangeRequest(ctx, db, {
    organizationId: internalOrgId,
    sitePublicId: site[0]!.publicId,
    title,
  });
  if (!created.ok) throw new Error(`could not create: ${created.message}`);
  return created.publicId;
}

describe("the agency's own change requests", () => {
  it("stays out of the operator queue, which is the whole point of the tab", async () => {
    const publicId = await newInternalRequest("Tighten the homepage copy");

    const queue = await listAllChangeRequests(ctx, db, { limit: 200 });

    expect(queue.map((r) => r.publicId)).not.toContain(publicId);
    // The filter, not an empty table, is doing the work.
    expect(queue.length).toBeGreaterThan(0);
  });

  it("appears on its own tab instead", async () => {
    const publicId = await newInternalRequest("Add a case study");

    const own = await listInternalChangeRequests(ctx, db, internalOrgId);

    expect(own.map((r) => r.publicId)).toContain(publicId);
  });

  it("says whether the agent has been handed it", async () => {
    const publicId = await newInternalRequest("Swap the hero image");

    const own = await listInternalChangeRequests(ctx, db, internalOrgId);
    const row = own.find((r) => r.publicId === publicId)!;

    // The distinction the tab could not draw: nothing has been sent yet.
    expect(row).toHaveProperty("agentDispatchedAt");
    expect(row.agentDispatchedAt).toBeNull();
    expect(row.agentPrUrl).toBeNull();
  });

  it("reports a job once one exists, in a shape the page can render", async () => {
    const publicId = await newInternalRequest("Already under way");
    const [request] = await db
      .select({ id: changeRequests.id })
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));

    const dispatchedAt = new Date("2026-09-09T10:00:00Z");
    await db.insert(agentJobs).values({
      publicId: newPublicId(),
      requestId: request!.id,
      status: "pr_open",
      dispatchedAt,
      prUrl: "https://github.com/cjackmort/mortensenweb/pull/1",
    });

    const own = await listInternalChangeRequests(ctx, db, internalOrgId);
    const row = own.find((r) => r.publicId === publicId)!;

    expect(row.agentDispatchedAt).not.toBeNull();
    expect(row.agentPrUrl).toBe(
      "https://github.com/cjackmort/mortensenweb/pull/1",
    );
    // The page formats this with `new Date(...)`. Drivers return a timestamp
    // subquery as a string rather than a Date, so the value has to survive that
    // regardless of which one the column claims to be — a render-time throw on
    // an admin page is not something a test suite should let through.
    expect(Number.isNaN(new Date(row.agentDispatchedAt!).getTime())).toBe(false);
    expect(new Date(row.agentDispatchedAt!).toISOString()).toBe(
      dispatchedAt.toISOString(),
    );
  });

  it("can be dispatched — the gap this file was written for", async () => {
    const publicId = await newInternalRequest("Fix the pricing table");

    const outcome = await dispatchInternalChangeRequest(
      ctx,
      db,
      internalOrgId,
      publicId,
    );

    // GitHub is not configured under test, so a successful dispatch is not
    // reachable here. What matters is *which* refusal comes back: reaching the
    // dispatcher at all is what was impossible before. `not_found` would mean
    // the request is still unreachable through this path.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).not.toBe("not_found");
      expect(outcome.reason).toBe("not_configured");
    }
  });

  it("refuses a request belonging to a client, from the agency's tab", async () => {
    const acmeRequests = await db
      .select({ publicId: changeRequests.publicId })
      .from(changeRequests)
      .where(eq(changeRequests.organizationId, acme.organizationId));

    const outcome = await dispatchInternalChangeRequest(
      ctx,
      db,
      internalOrgId,
      acmeRequests[0]!.publicId,
    );

    // Not a privilege boundary — an admin may dispatch that request from the
    // operator queue, where the client it belongs to is on screen. This tab is
    // about one organization and must not act outside it.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_found");
  });

  it("leaves no request reachable by neither queue", async () => {
    const publicId = await newInternalRequest("The invariant");

    const queue = await listAllChangeRequests(ctx, db, { limit: 200 });
    const own = await listInternalChangeRequests(ctx, db, internalOrgId);

    const inQueue = queue.some((r) => r.publicId === publicId);
    const inOwn = own.some((r) => r.publicId === publicId);

    // Exactly one, always. Hidden from both is the bug; visible in both is the
    // mixing the tab exists to prevent.
    expect(inQueue !== inOwn).toBe(true);
  });
});
