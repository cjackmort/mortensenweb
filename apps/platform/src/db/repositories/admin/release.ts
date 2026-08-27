import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  organizations,
  requestEvents,
} from "@/db/schema";
import type { AdminContext } from "../context";

/**
 * The operator's look at a preview before the client gets it.
 *
 * Deliberately temporary. While the agents are still earning trust, a client
 * should not be the person who discovers that a change came out wrong — that
 * costs confidence which is slow to win back, and the cost of a person opening
 * a preview first is a minute.
 *
 * The gate is a timestamp rather than a setting, so removing it later means
 * deleting one predicate from the client query rather than unpicking a feature
 * flag from four places.
 *
 * Note the direction of the default: `operator_released_at` starts null, and
 * the client query requires it to be set. Forgetting to release shows the
 * client nothing. The opposite default — released unless withheld — would mean
 * a missed review shows them an unreviewed change, which is the failure this
 * exists to prevent.
 */

export interface PendingRelease {
  agentJobPublicId: string;
  requestPublicId: string;
  requestTitle: string;
  organizationName: string;
  previewUrl: string;
  builtAt: Date | null;
}

/**
 * Previews built and waiting on a person.
 *
 * Only verified ones. An unverified preview URL is a prediction — derivable the
 * moment a pull request opens, long before a build exists at it — so offering
 * one for review would send the operator to a 404 and ask them to judge it.
 */
export async function listPreviewsAwaitingRelease(
  _ctx: AdminContext,
  db: Database,
): Promise<PendingRelease[]> {
  const rows = await db
    .select({
      agentJobPublicId: agentJobs.publicId,
      requestPublicId: changeRequests.publicId,
      requestTitle: changeRequests.title,
      organizationName: organizations.name,
      previewUrl: agentJobs.previewUrl,
      builtAt: agentJobs.previewVerifiedAt,
    })
    .from(agentJobs)
    .innerJoin(changeRequests, eq(changeRequests.id, agentJobs.requestId))
    .innerJoin(organizations, eq(organizations.id, changeRequests.organizationId))
    .where(
      and(
        eq(agentJobs.status, "pr_open"),
        isNull(agentJobs.operatorReleasedAt),
      ),
    )
    .orderBy(desc(agentJobs.previewVerifiedAt));

  return rows
    .filter(
      (row): row is typeof row & { previewUrl: string } =>
        Boolean(row.previewUrl) && row.builtAt !== null,
    )
    .map((row) => ({
      agentJobPublicId: row.agentJobPublicId,
      requestPublicId: row.requestPublicId,
      requestTitle: row.requestTitle,
      organizationName: row.organizationName,
      previewUrl: row.previewUrl,
      builtAt: row.builtAt,
    }));
}

export type ReleaseOutcome = { ok: boolean; message: string };

/** Hand a preview to the client. */
export async function releasePreview(
  ctx: AdminContext,
  db: Database,
  agentJobPublicId: string,
): Promise<ReleaseOutcome> {
  const rows = await db
    .select({
      id: agentJobs.id,
      requestId: agentJobs.requestId,
      released: agentJobs.operatorReleasedAt,
      status: agentJobs.status,
    })
    .from(agentJobs)
    .where(eq(agentJobs.publicId, agentJobPublicId))
    .limit(1);

  const job = rows[0];
  if (!job) return { ok: false, message: "No such preview." };
  if (job.released) return { ok: false, message: "Already released." };
  if (job.status !== "pr_open") {
    return { ok: false, message: "That change is no longer waiting on a preview." };
  }

  const now = new Date();

  await db
    .update(agentJobs)
    .set({ operatorReleasedAt: now, operatorReleasedBy: ctx.userId })
    .where(eq(agentJobs.id, job.id));

  if (job.requestId) {
    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "system",
      kind: "preview_released",
      body: "Your change is ready to look at.",
      visibility: "client_visible",
    });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "preview.released",
    entityType: "agent_job",
    entityId: agentJobPublicId,
  });

  return { ok: true, message: "Sent to the client." };
}

/**
 * Reject a preview before the client ever sees it.
 *
 * Records why, internally, and leaves the request where it is. It does not
 * cancel and it does not notify — the operator is going to fix it or re-run it,
 * and telling a client that something they never saw was rejected would raise a
 * worry rather than settle one.
 */
export async function holdPreview(
  ctx: AdminContext,
  db: Database,
  agentJobPublicId: string,
  reason: string,
): Promise<ReleaseOutcome> {
  const rows = await db
    .select({ id: agentJobs.id, requestId: agentJobs.requestId })
    .from(agentJobs)
    .where(eq(agentJobs.publicId, agentJobPublicId))
    .limit(1);

  const job = rows[0];
  if (!job) return { ok: false, message: "No such preview." };

  if (job.requestId) {
    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "admin",
      actorUserId: ctx.userId,
      kind: "preview_held",
      body: reason.trim() || "Held by an operator before the client saw it.",
      visibility: "internal",
    });
  }

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "preview.held",
    entityType: "agent_job",
    entityId: agentJobPublicId,
    metadata: { reason: reason.trim() || null },
  });

  return { ok: true, message: "Held. The client has not been shown it." };
}
