import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeAllowances,
  changeRequests,
  clients,
  organizations,
  requestEvents,
  servicePlans,
  sites,
  subscriptions,
  users,
} from "@/db/schema";
import {
  tenantContextFrom,
  type SessionLike,
  type TenantContext,
} from "@/db/repositories/context";
import {
  createChangeRequest,
  findOpenRequestForSite,
} from "@/db/repositories/client/change-requests";
import { consumeChange } from "@/db/repositories/client/entitlements";
import { cancelChangeRequest } from "@/db/repositories/admin/cancel";
import { parseEscalationMarker } from "@/lib/github/issue";
import { netlifyKeyFor } from "@/db/repositories/admin/shipped";
import {
  ALL_STATUSES,
  BLOCKING_STATUSES,
  STAGES,
  blocksNewRequest,
  isCancellable,
  isOpen,
  stageIndex,
} from "@/lib/requests/status";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";

/**
 * Cancelling a change, and the one-open-request-per-site rule.
 *
 * The two are one feature. The rule exists because two changes open at once
 * means the second agent branch was cut before the first landed, so merging it
 * can quietly undo the first — the client asks for two things, gets one, and
 * nothing reports a problem. Cancelling is what stops that rule from trapping
 * someone: without it, a client who does not want the change they asked for
 * cannot raise anything else until an operator intervenes.
 *
 * What these tests are really for:
 *  - a request that has already merged must never be cancellable, because the
 *    commit is on the default branch and "cancel" would be a lie;
 *  - one tenant must not see or block another tenant's requests;
 *  - `deployed` must still block a new request, because the deploy is what the
 *    next branch will be cut from and it has not been confirmed yet.
 */

let db: Database;
let close: () => Promise<void>;

interface Tenant {
  orgId: string;
  clientId: string;
  userId: string;
  ctx: TenantContext;
  siteAPublicId: string;
  siteBPublicId: string;
}

let acme: Tenant;
let globex: Tenant;

function sessionFor(orgId: string, userId: string): SessionLike {
  return {
    userId,
    organizationId: orgId,
    role: "client",
    status: "active",
    sessionEpoch: 0,
  };
}

async function seedTenant(slug: string, planId: string): Promise<Tenant> {
  const org = (
    await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: slug, slug, kind: "client" })
      .returning()
  )[0]!;

  const user = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: `${slug}@example.test`,
        role: "client",
        status: "active",
      })
      .returning()
  )[0]!;

  const client = (
    await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org.id })
      .returning()
  )[0]!;

  await db.insert(subscriptions).values({
    publicId: newPublicId(),
    clientId: client.id,
    planId,
    monthlyPriceCents: 9900,
    startedOn: "2026-01-01",
    status: "active",
  });

  const siteRows = await db
    .insert(sites)
    .values([
      {
        publicId: newPublicId(),
        organizationId: org.id,
        name: `${slug} site A`,
        status: "live",
      },
      {
        publicId: newPublicId(),
        organizationId: org.id,
        name: `${slug} site B`,
        status: "live",
      },
    ])
    .returning();

  return {
    orgId: org.id,
    clientId: client.id,
    userId: user.id,
    ctx: tenantContextFrom(sessionFor(org.id, user.id), org.id),
    siteAPublicId: siteRows[0]!.publicId,
    siteBPublicId: siteRows[1]!.publicId,
  };
}

beforeAll(async () => {
  const harness = await createTestDb();
  db = harness.db;
  close = harness.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(requestEvents);
  await db.delete(agentJobs);
  await db.delete(changeRequests);
  await db.delete(changeAllowances);
  await db.delete(subscriptions);
  await db.delete(clients);
  await db.delete(sites);
  await db.delete(users);
  await db.delete(organizations);
  await db.delete(servicePlans);

  const plan = (
    await db
      .insert(servicePlans)
      .values({
        key: "care-basic",
        name: "Care — Basic",
        defaultMonthlyCents: 9900,
        includedChangesPerMonth: 3,
        overagePerChangeCents: 3900,
        includesAnalytics: true,
      })
      .returning()
  )[0]!;

  acme = await seedTenant("acme", plan.id);
  globex = await seedTenant("globex", plan.id);
});

describe("the client-facing progress track", () => {
  it("gives waiting-on-the-client its own stage", () => {
    // The whole point of the five-step track: "we're building it" and "we're
    // waiting on you" used to collapse into one stage, so a client had no way
    // to tell that the pipeline had stopped for them.
    expect(STAGES).toHaveLength(5);
    expect(STAGES[2]).toBe("Needs your approval");
    expect(stageIndex("pr_open")).toBe(2);
    expect(stageIndex("in_progress")).toBe(1);
  });

  it("sends a rejected preview back to building, not to approval", () => {
    // changes_requested means the client has already looked and asked for
    // something different. The next thing to happen is another preview.
    expect(stageIndex("changes_requested")).toBe(1);
  });

  it("does not report a merged change as confirmed live", () => {
    // merged sits at Published with the deploy still running. Reaching
    // "Confirmed live" here is how a broken deploy reports itself as finished.
    expect(stageIndex("merged")).toBe(3);
    expect(stageIndex("deployed")).toBe(3);
    expect(stageIndex("verified")).toBe(4);
  });
});

describe("which requests may be cancelled", () => {
  it("allows anything that has not reached the live site", () => {
    for (const status of [
      "submitted",
      "triaged",
      "approved",
      "dispatched",
      "in_progress",
      "pr_open",
      "changes_requested",
      "failed",
    ]) {
      expect(isCancellable(status)).toBe(true);
    }
  });

  it("refuses once the commit is on the default branch", () => {
    // Past this point cancelling is a rollback, which is a different operation.
    expect(isCancellable("merged")).toBe(false);
    expect(isCancellable("deployed")).toBe(false);
  });

  it("refuses anything already settled", () => {
    for (const status of ["verified", "closed", "rejected", "rolled_back"]) {
      expect(isCancellable(status)).toBe(false);
      expect(isOpen(status)).toBe(false);
    }
  });
});

describe("the rule can never trap a client", () => {
  it("blocks exactly what it lets you cancel", () => {
    // The invariant that makes deadlock impossible by construction. If these
    // two sets ever diverge, the gap between them is a set of states where a
    // client is blocked from raising anything and cannot clear it themselves.
    for (const status of ALL_STATUSES) {
      expect(blocksNewRequest(status)).toBe(isCancellable(status));
    }
  });

  it("keeps the query's literal list honest", () => {
    // BLOCKING_STATUSES is spelled out for Drizzle and so is a second source of
    // truth. This is what stops it drifting from the function.
    const derived = ALL_STATUSES.filter(blocksNewRequest).sort();
    expect([...BLOCKING_STATUSES].sort()).toEqual(derived);
  });

  it("releases the block once the change is on the default branch", () => {
    // The bug this replaced: blocking until `verified` locked a client out for
    // good, because nothing advanced a request past `merged`.
    expect(blocksNewRequest("merged")).toBe(false);
    expect(blocksNewRequest("deployed")).toBe(false);
    expect(blocksNewRequest("pr_open")).toBe(true);
  });
});

describe("one open request per site", () => {
  it("finds the open request blocking a site", async () => {
    await createChangeRequest(db, acme.ctx, {
      title: "Swap the hero image",
      sitePublicId: acme.siteAPublicId,
    });

    const open = await findOpenRequestForSite(db, acme.ctx, acme.siteAPublicId);
    expect(open?.title).toBe("Swap the hero image");
  });

  it("does not let one site block another", async () => {
    await createChangeRequest(db, acme.ctx, {
      title: "Site A change",
      sitePublicId: acme.siteAPublicId,
    });

    expect(
      await findOpenRequestForSite(db, acme.ctx, acme.siteBPublicId),
    ).toBeNull();
  });

  it("stops blocking once the change is merged, before it is verified", async () => {
    // The next agent branch is cut from the default branch, which now contains
    // this change — so the next request is safe to raise. Holding out for
    // `verified` is what locked clients out when nothing advanced past merged.
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Merged, deploy still running",
      sitePublicId: acme.siteAPublicId,
    });
    await db
      .update(changeRequests)
      .set({ status: "merged" })
      .where(eq(changeRequests.id, created.id));

    expect(
      await findOpenRequestForSite(db, acme.ctx, acme.siteAPublicId),
    ).toBeNull();
  });

  it("keeps blocking while a change is still only a pull request", async () => {
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Waiting on approval",
      sitePublicId: acme.siteAPublicId,
    });
    await db
      .update(changeRequests)
      .set({ status: "pr_open" })
      .where(eq(changeRequests.id, created.id));

    const open = await findOpenRequestForSite(db, acme.ctx, acme.siteAPublicId);
    expect(open?.status).toBe("pr_open");
  });

  it("stops blocking once the request is settled", async () => {
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Finished change",
      sitePublicId: acme.siteAPublicId,
    });
    await db
      .update(changeRequests)
      .set({ status: "verified" })
      .where(eq(changeRequests.id, created.id));

    expect(
      await findOpenRequestForSite(db, acme.ctx, acme.siteAPublicId),
    ).toBeNull();
  });

  it("does not see another tenant's open request", async () => {
    await createChangeRequest(db, globex.ctx, {
      title: "Globex confidential change",
      sitePublicId: globex.siteAPublicId,
    });

    // Acme asking about its own site must not be blocked by Globex, and Acme
    // passing Globex's site id must be treated as a site that does not exist.
    expect(
      await findOpenRequestForSite(db, acme.ctx, acme.siteAPublicId),
    ).toBeNull();
    await expect(
      findOpenRequestForSite(db, acme.ctx, globex.siteAPublicId),
    ).rejects.toThrow();
  });
});

describe("cancelling a change", () => {
  it("closes the request and hands back the change", async () => {
    const claim = await consumeChange(db, acme.ctx);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const created = await createChangeRequest(db, acme.ctx, {
      title: "Actually, never mind",
      sitePublicId: acme.siteAPublicId,
      allowanceId: claim.allowanceId,
    });

    const before = (
      await db
        .select({ used: changeAllowances.used })
        .from(changeAllowances)
        .where(eq(changeAllowances.id, claim.allowanceId))
    )[0]!;
    expect(before.used).toBe(1);

    const outcome = await cancelChangeRequest(db, {
      requestId: created.id,
      actorUserId: acme.userId,
      actorType: "client",
      reason: "Changed my mind",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refunded).toBe(true);

    const after = (
      await db
        .select({ used: changeAllowances.used })
        .from(changeAllowances)
        .where(eq(changeAllowances.id, claim.allowanceId))
    )[0]!;
    expect(after.used).toBe(0);

    const row = (
      await db
        .select({ status: changeRequests.status, closedAt: changeRequests.closedAt })
        .from(changeRequests)
        .where(eq(changeRequests.id, created.id))
    )[0]!;
    expect(row.status).toBe("closed");
    expect(row.closedAt).not.toBeNull();

    // The client raised it, so they are entitled to see it closed and why.
    const events = await db
      .select({ kind: requestEvents.kind, visibility: requestEvents.visibility })
      .from(requestEvents)
      .where(eq(requestEvents.requestId, created.id));
    const cancelled = events.find((e) => e.kind === "request_cancelled");
    expect(cancelled?.visibility).toBe("client_visible");
  });

  it("unblocks the site so a new request can be raised", async () => {
    const created = await createChangeRequest(db, acme.ctx, {
      title: "The one they changed their mind about",
      sitePublicId: acme.siteAPublicId,
    });

    await cancelChangeRequest(db, {
      requestId: created.id,
      actorUserId: acme.userId,
      actorType: "client",
    });

    expect(
      await findOpenRequestForSite(db, acme.ctx, acme.siteAPublicId),
    ).toBeNull();
  });

  it("refuses once the change has merged", async () => {
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Already on the branch",
      sitePublicId: acme.siteAPublicId,
    });
    await db
      .update(changeRequests)
      .set({ status: "merged" })
      .where(eq(changeRequests.id, created.id));

    const outcome = await cancelChangeRequest(db, {
      requestId: created.id,
      actorUserId: acme.userId,
      actorType: "client",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("already_live");

    // And it must not have been closed anyway.
    const row = (
      await db
        .select({ status: changeRequests.status })
        .from(changeRequests)
        .where(eq(changeRequests.id, created.id))
    )[0]!;
    expect(row.status).toBe("merged");
  });

  it("refuses a request that is already closed", async () => {
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Done already",
      sitePublicId: acme.siteAPublicId,
    });
    await db
      .update(changeRequests)
      .set({ status: "closed" })
      .where(eq(changeRequests.id, created.id));

    const outcome = await cancelChangeRequest(db, {
      requestId: created.id,
      actorUserId: acme.userId,
      actorType: "client",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("already_settled");
  });

  it("marks the agent job cancelled without reaching GitHub when there is no pull request", async () => {
    const created = await createChangeRequest(db, acme.ctx, {
      title: "Dispatched but nothing opened yet",
      sitePublicId: acme.siteAPublicId,
    });

    const job = (
      await db
        .insert(agentJobs)
        .values({
          publicId: newPublicId(),
          requestId: created.id,
          status: "dispatched",
        })
        .returning()
    )[0]!;

    const outcome = await cancelChangeRequest(db, {
      requestId: created.id,
      actorUserId: acme.userId,
      actorType: "client",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pullRequestClosed).toBe(false);

    const row = (
      await db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id))
    )[0]!;
    expect(row.status).toBe("cancelled");
  });
});

describe("escalating a change to a person", () => {
  it("reads the marker and its reason", () => {
    const parsed = parseEscalationMarker(
      "<!-- agent-job:01ARZ3NDEKTSV4RRFFQ69G5FAV -->\n" +
        "<!-- agent-escalation: needs a new page template -->\n\nDetail here.",
    );
    expect(parsed.escalated).toBe(true);
    expect(parsed.reason).toBe("needs a new page template");
  });

  it("accepts a bare marker with no reason", () => {
    expect(parseEscalationMarker("<!-- agent-escalation -->").escalated).toBe(true);
    expect(parseEscalationMarker("<!-- agent-escalation -->").reason).toBeNull();
  });

  it("does not fire on an ordinary pull request", () => {
    // Every normal agent PR carries the job marker. Confusing the two would
    // escalate every change that ever succeeded.
    expect(
      parseEscalationMarker("<!-- agent-job:01ARZ3NDEKTSV4RRFFQ69G5FAV -->\nSwapped the hero.")
        .escalated,
    ).toBe(false);
    expect(parseEscalationMarker(null).escalated).toBe(false);
  });

  it("flattens and caps the reason", () => {
    // Written by a model that has just read untrusted client text, so it is
    // treated as a label rather than a document.
    // An over-long reason must never stop the marker matching: missing the
    // escalation entirely is far worse than truncating a label.
    const parsed = parseEscalationMarker(
      `<!-- agent-escalation: ${"x".repeat(400)} -->`,
    );
    expect(parsed.escalated).toBe(true);
    expect(parsed.reason).toHaveLength(200);
    expect(parsed.reason?.endsWith("…")).toBe(true);

    const wrapped = parseEscalationMarker(
      "<!-- agent-escalation: needs   a\tnew page -->",
    );
    expect(wrapped.reason).toBe("needs a new page");
  });
});

describe("an escalated request", () => {
  it("still blocks the site and can still be cancelled", () => {
    // It is open work waiting on a person, so it holds the slot — and the
    // invariant means the client is never trapped by it.
    expect(blocksNewRequest("needs_operator")).toBe(true);
    expect(isCancellable("needs_operator")).toBe(true);
    expect(isOpen("needs_operator")).toBe(true);
  });

  it("is not shown as a point on the happy path", () => {
    // A part-filled progress bar would suggest it is still moving on its own.
    expect(stageIndex("needs_operator")).toBeNull();
  });
});

describe("addressing a Netlify site", () => {
  it("uses the stored id when the portal scaffolded the site", () => {
    expect(
      netlifyKeyFor({ netlifySiteId: "abc-123", netlifySiteName: "scott" }),
    ).toBe("abc-123");
  });

  it("falls back to the name for a repository connected in place", () => {
    // The bug this fixes: connect-repo stores only the name, so requiring the
    // id skipped those sites silently and their changes stayed at `merged`.
    expect(
      netlifyKeyFor({ netlifySiteId: null, netlifySiteName: "scott-mortensen-fine-arts" }),
    ).toBe("scott-mortensen-fine-arts.netlify.app");
  });

  it("reports nothing usable rather than guessing", () => {
    expect(
      netlifyKeyFor({ netlifySiteId: null, netlifySiteName: null }),
    ).toBeNull();
  });
});
