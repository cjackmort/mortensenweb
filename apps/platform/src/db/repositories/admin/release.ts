import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  organizations,
  repositoryConnections,
  requestEvents,
} from "@/db/schema";
import { notifyClientOfRequest } from "@/lib/notify/request";
import { dispatchChangeRequest } from "./agent-jobs";
import { closeAbandonedPullRequest } from "./cancel";
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
    // The email waits for this moment, not for the build. Sent when the build
    // verified, it handed the client a link to a preview nobody had checked —
    // including ones an operator was about to send back.
    await notifyClientOfRequest(db, job.requestId, "preview_ready");
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
 * Send a preview back to the agent before the client ever sees it.
 *
 * The operator's notes go to a new agent run, which starts from the held pull
 * request's commits and opens a new one; its preview comes back to this queue
 * once built. Holding used to stop at recording the notes, so the held preview
 * sat in the queue and nothing ever acted on what was wrong with it.
 *
 * The client is told nothing, here or by the new run. They never saw the held
 * preview, and telling them something they never saw was rejected would raise
 * a worry rather than settle one.
 *
 * **The held job is retired before the new run starts**, and only if it is
 * still waiting, so a second click cannot start a second run. If the run cannot
 * be started the job is put back: a preview that vanished from the queue with
 * nothing replacing it is worse than the one the operator was unhappy with.
 */
export async function holdPreview(
  ctx: AdminContext,
  db: Database,
  agentJobPublicId: string,
  feedback: string,
): Promise<ReleaseOutcome> {
  const notes = feedback.trim();
  if (!notes) {
    return {
      ok: false,
      message: "Say what needs changing — the agent's next attempt works from these notes.",
    };
  }

  const job = await findHeldJob(db, agentJobPublicId);
  if (!job) return { ok: false, message: "No such preview." };

  const retired = await db
    .update(agentJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(
      and(
        eq(agentJobs.id, job.id),
        eq(agentJobs.status, "pr_open"),
        isNull(agentJobs.operatorReleasedAt),
      ),
    )
    .returning({ id: agentJobs.id });

  if (retired.length === 0) {
    return { ok: false, message: "That preview is no longer waiting on you." };
  }

  const outcome = await startRevision(ctx, db, job, notes);
  if (!outcome.ok) {
    return { ok: false, message: `Not sent back — ${outcome.message}` };
  }

  await recordHold(ctx, db, {
    requestId: job.requestId,
    heldJobPublicId: agentJobPublicId,
    revisionJobPublicId: outcome.agentJobPublicId,
    issueNumber: outcome.issueNumber,
    notes,
  });

  await closeAbandonedPullRequest(
    db,
    job.requestId,
    job,
    `Superseded by #${outcome.issueNumber}. This preview was reviewed and sent ` +
      "back for another attempt, which builds on these commits.",
  );

  return {
    ok: true,
    message:
      `Sent back to the agent with your notes (issue #${outcome.issueNumber}). ` +
      "The new preview will appear here once it is built.",
  };
}

type HeldJob = NonNullable<Awaited<ReturnType<typeof findHeldJob>>>;

/** The job, its request, and where its pull request lives. */
async function findHeldJob(db: Database, agentJobPublicId: string) {
  const rows = await db
    .select({
      id: agentJobs.id,
      requestId: changeRequests.id,
      requestPublicId: changeRequests.publicId,
      prNumber: agentJobs.prNumber,
      installationId: repositoryConnections.installationId,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      defaultBranch: repositoryConnections.defaultBranch,
    })
    .from(agentJobs)
    .innerJoin(changeRequests, eq(changeRequests.id, agentJobs.requestId))
    .leftJoin(
      repositoryConnections,
      eq(repositoryConnections.id, agentJobs.repositoryConnectionId),
    )
    .where(eq(agentJobs.publicId, agentJobPublicId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Dispatch the second attempt, putting the held job back if it does not start.
 *
 * Every refusal `dispatchChangeRequest` can give — the day's cap, GitHub being
 * unreachable, the repository losing its allowlisting — leaves nothing running,
 * so the held preview is still the latest thing built and belongs in the queue.
 */
async function startRevision(
  ctx: AdminContext,
  db: Database,
  job: HeldJob,
  notes: string,
) {
  const restore = () =>
    db
      .update(agentJobs)
      .set({ status: "pr_open", finishedAt: null })
      .where(eq(agentJobs.id, job.id));

  try {
    const outcome = await dispatchChangeRequest(ctx, db, {
      requestPublicId: job.requestPublicId,
      revision: { previousPullRequest: job.prNumber, feedback: notes },
    });
    if (!outcome.ok) await restore();
    return outcome;
  } catch (error) {
    await restore();
    throw error;
  }
}

/** Internal only: the notes, and which run replaced which. */
async function recordHold(
  ctx: AdminContext,
  db: Database,
  hold: {
    requestId: string;
    heldJobPublicId: string;
    revisionJobPublicId: string;
    issueNumber: number;
    notes: string;
  },
): Promise<void> {
  const links = {
    revisionAgentJobPublicId: hold.revisionJobPublicId,
    issueNumber: hold.issueNumber,
  };

  await db.insert(requestEvents).values({
    requestId: hold.requestId,
    actorType: "admin",
    actorUserId: ctx.userId,
    kind: "preview_held",
    body: hold.notes,
    visibility: "internal",
    metadata: { heldAgentJobPublicId: hold.heldJobPublicId, ...links },
  });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "preview.held",
    entityType: "agent_job",
    entityId: hold.heldJobPublicId,
    metadata: { reason: hold.notes, ...links },
  });
}
