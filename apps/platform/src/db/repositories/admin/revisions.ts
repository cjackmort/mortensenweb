import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  repositoryConnections,
  requestEvents,
} from "@/db/schema";
import {
  dispatchRevision,
  isAutoDispatchEnabled,
  type DispatchActor,
  type DispatchOutcome,
} from "./agent-jobs";
import { closeAbandonedPullRequest } from "./cancel";

/**
 * Sending a built preview back to the agent for another attempt.
 *
 * Two people can do it. The operator, before the client has seen the preview
 * ("Hold it back"); and the client, after it has been released to them ("Ask
 * for changes"). Both mean the same thing — this result is not right, here is
 * what to change — so both take the same road: the held job is retired, a new
 * run starts from its pull request's commits with the notes, and the held pull
 * request is closed. The new preview comes back to the operator to check before
 * the client sees it, whoever sent it back.
 *
 * **The held job is retired first**, and only if it is still in the state the
 * caller expects, so two clicks — or a click racing the schedule — start one
 * run. If the run cannot be started the job is put back: a preview that
 * vanished with nothing replacing it is worse than the one that was sent back.
 */

export interface RevisableJob {
  id: string;
  publicId: string;
  requestId: string;
  requestPublicId: string;
  prNumber: number | null;
  installationId: string | null;
  owner: string | null;
  name: string | null;
  defaultBranch: string | null;
}

export type RevisionOutcome =
  | DispatchOutcome
  | { ok: false; reason: "not_waiting" | "no_notes"; message: string };

function revisableJobs(db: Database, where: SQL) {
  return db
    .select({
      id: agentJobs.id,
      publicId: agentJobs.publicId,
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
    .where(where)
    .orderBy(desc(agentJobs.createdAt))
    .limit(1);
}

export async function findJobByPublicId(
  db: Database,
  agentJobPublicId: string,
): Promise<RevisableJob | null> {
  return (await revisableJobs(db, eq(agentJobs.publicId, agentJobPublicId)))[0] ?? null;
}

/**
 * Retire one built preview's job and start a second attempt from it.
 *
 * `stillWaiting` is the caller's own condition on the job — not yet released,
 * for the operator; sent back by the client, for the client — applied in the
 * same statement that retires it.
 */
export async function retireAndRedispatch(
  db: Database,
  input: {
    job: RevisableJob;
    notes: string;
    reviewer: "operator" | "client";
    actor: DispatchActor;
    stillWaiting: SQL;
  },
): Promise<RevisionOutcome> {
  const { job } = input;

  const retired = await db
    .update(agentJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "pr_open"), input.stillWaiting))
    .returning({ id: agentJobs.id });

  if (retired.length === 0) {
    return { ok: false, reason: "not_waiting", message: "That preview is no longer waiting on a decision." };
  }

  const restore = () =>
    db.update(agentJobs).set({ status: "pr_open", finishedAt: null }).where(eq(agentJobs.id, job.id));

  let outcome: DispatchOutcome;
  try {
    outcome = await dispatchRevision(
      db,
      {
        requestPublicId: job.requestPublicId,
        revision: {
          previousPullRequest: job.prNumber,
          feedback: input.notes,
          reviewer: input.reviewer,
        },
      },
      input.actor,
    );
  } catch (error) {
    await restore();
    throw error;
  }

  if (!outcome.ok) {
    await restore();
    return outcome;
  }

  const why =
    input.reviewer === "client"
      ? "The client asked for changes to this preview"
      : "This preview was reviewed and sent back for another attempt";
  await closeAbandonedPullRequest(
    db,
    job.requestId,
    job,
    `Superseded by #${outcome.issueNumber}. ${why}; the new attempt builds on these commits.`,
  );

  return outcome;
}

/** What the client said, from the event their "Ask for changes" recorded. */
async function clientNotes(db: Database, requestId: string): Promise<string | null> {
  const rows = await db
    .select({ body: requestEvents.body, metadata: requestEvents.metadata })
    .from(requestEvents)
    .where(and(eq(requestEvents.requestId, requestId), eq(requestEvents.kind, "changes_requested")))
    .orderBy(desc(requestEvents.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const note = (row.metadata as { note?: unknown } | null)?.note;
  if (typeof note === "string" && note.trim()) return note.trim();
  // Recorded before the note was kept on its own.
  const fromBody = row.body?.replace(/^You asked for changes:\s*/, "").trim();
  return fromBody && !fromBody.startsWith("You asked for more changes") ? fromBody : null;
}

/**
 * The client asked for changes to a preview they were given: start the redo.
 *
 * Run by the schedule when automatic work is on, and by the operator's button
 * on the queue when it is not — so a client's request for changes is never a
 * dead end, whichever way the portal is configured.
 */
export async function redoAfterClientChanges(
  db: Database,
  requestPublicId: string,
  actor: DispatchActor,
): Promise<RevisionOutcome> {
  const job = (
    await revisableJobs(
      db,
      and(
        eq(changeRequests.publicId, requestPublicId),
        eq(changeRequests.status, "changes_requested"),
      )!,
    )
  )[0];

  if (!job) {
    return { ok: false, reason: "not_waiting", message: "This request is not waiting on changes." };
  }

  const notes = await clientNotes(db, job.requestId);
  if (!notes) {
    return {
      ok: false,
      reason: "no_notes",
      message: "The client asked for changes without saying what. Ask them before starting again.",
    };
  }

  const outcome = await retireAndRedispatch(db, {
    job,
    notes,
    reviewer: "client",
    actor,
    stillWaiting: eq(agentJobs.clientDecision, "changes_requested"),
  });

  if (outcome.ok) {
    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "system",
      kind: "work_started",
      body: "We've started on the changes you asked for.",
      visibility: "client_visible",
    });
  }

  return outcome;
}

/**
 * The schedule's half: every request a client sent back, while automatic work
 * is on. Bounded per tick, like `dispatchSubmittedRequests`, so one tick never
 * tries to open more issues than fit in a function's time.
 */
export async function redoChangesRequested(
  db: Database,
  { limit = 5 }: { limit?: number } = {},
): Promise<{ dispatched: number; refused: number }> {
  if (!isAutoDispatchEnabled()) return { dispatched: 0, refused: 0 };

  const waiting = await db
    .select({ publicId: changeRequests.publicId })
    .from(changeRequests)
    .where(eq(changeRequests.status, "changes_requested"))
    .orderBy(changeRequests.updatedAt)
    .limit(limit);

  let dispatched = 0;
  let refused = 0;

  for (const request of waiting) {
    try {
      const outcome = await redoAfterClientChanges(db, request.publicId, { automatic: true });
      if (outcome.ok) dispatched += 1;
      else refused += 1;
    } catch (error) {
      // One unreachable repository must not stop the rest of the batch.
      refused += 1;
      console.error("[revisions] scheduled redo failed", {
        requestPublicId: request.publicId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return { dispatched, refused };
}
