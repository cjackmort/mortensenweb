import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  repositoryConnections,
  requestEvents,
  sites,
} from "@/db/schema";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * The client's side of "look at it, then apply it".
 *
 * This is the surface where a client's click causes a write to their live
 * website, so the shape of it is chosen to make one thing impossible: applying
 * something other than what they looked at.
 *
 * The mechanism is the head SHA. The preview they were shown belongs to a
 * specific commit; approving records that commit; and the merge is pinned to
 * it. If anything pushes in between, the webhook clears the approval (see
 * `admin/webhooks.ts`, the `synchronize` branch) and they are asked again. At
 * no point does "approved" mean "approved in general".
 *
 * Every function here takes a `TenantContext` and filters on it. A client can
 * only ever reach jobs belonging to their own requests.
 */

export interface PendingPreview {
  requestPublicId: string;
  requestTitle: string;
  agentJobPublicId: string;
  previewUrl: string;
  /** Only set once the URL has actually been fetched and answered. */
  verifiedAt: Date;
  decision: "pending" | "approved" | "changes_requested";
}

/**
 * Previews this tenant can look at right now.
 *
 * Two filters do the real work. `previewVerifiedAt IS NOT NULL` means nothing
 * unverified is ever offered — a client is never sent to a URL that has not
 * answered. And the join through `change_requests` is what scopes this to the
 * tenant, because `agent_jobs` has no organization column of its own.
 */
export async function listPreviewsAwaitingDecision(
  db: Database,
  ctx: TenantContext,
): Promise<PendingPreview[]> {
  const rows = await db
    .select({
      requestPublicId: changeRequests.publicId,
      requestTitle: changeRequests.title,
      agentJobPublicId: agentJobs.publicId,
      previewUrl: agentJobs.previewUrl,
      verifiedAt: agentJobs.previewVerifiedAt,
      decision: agentJobs.clientDecision,
    })
    .from(agentJobs)
    .innerJoin(changeRequests, eq(changeRequests.id, agentJobs.requestId))
    .where(
      and(
        eq(changeRequests.organizationId, ctx.organizationId),
        eq(agentJobs.status, "pr_open"),
      ),
    )
    .orderBy(desc(agentJobs.createdAt));

  return rows
    .filter(
      (row): row is typeof row & { previewUrl: string; verifiedAt: Date } =>
        Boolean(row.previewUrl) && row.verifiedAt !== null,
    )
    .map((row) => ({
      requestPublicId: row.requestPublicId,
      requestTitle: row.requestTitle,
      agentJobPublicId: row.agentJobPublicId,
      previewUrl: row.previewUrl,
      verifiedAt: row.verifiedAt,
      decision: row.decision,
    }));
}

/** The live job for one request, scoped to the tenant. Null if not theirs. */
export async function findJobForRequest(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
) {
  const rows = await db
    .select({
      id: agentJobs.id,
      publicId: agentJobs.publicId,
      requestId: agentJobs.requestId,
      status: agentJobs.status,
      prNumber: agentJobs.prNumber,
      headSha: agentJobs.headSha,
      baseRef: agentJobs.baseRef,
      previewUrl: agentJobs.previewUrl,
      previewVerifiedAt: agentJobs.previewVerifiedAt,
      decision: agentJobs.clientDecision,
      connectionId: agentJobs.repositoryConnectionId,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      allowlisted: repositoryConnections.allowlisted,
      siteId: sites.id,
    })
    .from(agentJobs)
    .innerJoin(changeRequests, eq(changeRequests.id, agentJobs.requestId))
    .leftJoin(
      repositoryConnections,
      eq(repositoryConnections.id, agentJobs.repositoryConnectionId),
    )
    .leftJoin(sites, eq(sites.id, repositoryConnections.siteId))
    .where(
      and(
        eq(changeRequests.publicId, requestPublicId),
        // The tenant predicate. Without it this is a cross-tenant read of
        // repository names and installation ids.
        eq(changeRequests.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(desc(agentJobs.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

export type DecisionOutcome =
  | { ok: true; decision: "approved" | "changes_requested"; headSha: string }
  | {
      ok: false;
      reason: "not_found" | "no_preview" | "already_decided" | "wrong_status";
      message: string;
    };

/**
 * Record the client's verdict on a preview.
 *
 * This does **not** merge. It records a decision and returns the SHA it applies
 * to; the merge is a separate, guarded step (`admin/merge.ts`). Splitting them
 * matters: the decision is a client act that must always succeed and be
 * recorded, while the merge can legitimately be refused by a guard — and if
 * they were one function, a guard refusal would look to the client like their
 * approval had not registered.
 */
export async function recordPreviewDecision(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
  decision: "approved" | "changes_requested",
  note?: string,
): Promise<DecisionOutcome> {
  assertMutable(ctx);

  const job = await findJobForRequest(db, ctx, requestPublicId);
  if (!job) throw new NotFoundError();

  if (job.status !== "pr_open") {
    return {
      ok: false,
      reason: "wrong_status",
      message: "There's nothing waiting for your approval on this request.",
    };
  }
  if (!job.previewUrl || !job.previewVerifiedAt) {
    return {
      ok: false,
      reason: "no_preview",
      message: "The preview isn't ready yet. We'll let you know the moment it is.",
    };
  }
  if (!job.headSha) {
    return {
      ok: false,
      reason: "no_preview",
      message: "We couldn't identify which version you're approving. We're looking into it.",
    };
  }
  if (job.decision !== "pending") {
    return {
      ok: false,
      reason: "already_decided",
      message: "You've already responded to this one.",
    };
  }

  const now = new Date();

  // Conditional on still being pending, so a double-click cannot record two
  // decisions — and cannot record an approval over a "changes requested".
  const claimed = await db
    .update(agentJobs)
    .set({
      clientDecision: decision,
      clientDecisionAt: now,
      clientDecisionByUserId: ctx.userId,
    })
    .where(and(eq(agentJobs.id, job.id), eq(agentJobs.clientDecision, "pending")))
    .returning({ id: agentJobs.id });

  if (claimed.length === 0) {
    return {
      ok: false,
      reason: "already_decided",
      message: "You've already responded to this one.",
    };
  }

  if (job.requestId) {
    await db
      .update(changeRequests)
      .set({
        status: decision === "approved" ? "approved" : "changes_requested",
        updatedAt: now,
      })
      .where(eq(changeRequests.id, job.requestId));

    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "client",
      actorUserId: ctx.userId,
      kind: decision === "approved" ? "preview_approved" : "changes_requested",
      body:
        decision === "approved"
          ? "You approved this change. We're putting it live now."
          : note?.trim()
            ? `You asked for changes: ${note.trim()}`
            : "You asked for more changes before this goes live.",
      visibility: "client_visible",
    });
  }

  return { ok: true, decision, headSha: job.headSha };
}
