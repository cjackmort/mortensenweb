import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  repositoryConnections,
  requestEvents,
} from "@/db/schema";
import {
  closePullRequest,
  commentOnIssue,
  deleteBranch,
  getPullRequest,
  type Repo,
} from "@/lib/github/rest";
import { refundChange } from "@/db/repositories/client/entitlements";
import { isCancellable, isTooLateToCancel } from "@/lib/requests/status";

/**
 * Calling off a change.
 *
 * Like `applyApprovedChange`, this lives in the admin directory and is reached
 * by a client route through a server action that has already resolved and
 * verified the tenant. It takes a request id the caller proved ownership of;
 * there is no parameter here a client controls that could select another
 * tenant's request or another repository.
 *
 * **The database is updated before GitHub, and the pull request close is
 * best-effort.** That ordering is deliberate. Cancelling is the client's own
 * act and it must be recorded, but the one-open-request-per-site rule means a
 * cancellation that fails halfway leaves them unable to raise anything at all.
 * An orphaned pull request is an operational annoyance we can see and fix; a
 * client locked out of the portal by a GitHub timeout is not.
 */

export type CancelOutcome =
  | {
      ok: true;
      refunded: boolean;
      pullRequestClosed: boolean;
      message: string;
    }
  | {
      ok: false;
      reason: "not_found" | "already_live" | "already_settled";
      message: string;
    };

export interface CancelInput {
  /** Resolved and tenant-verified by the caller. Never taken from a form. */
  requestId: string;
  actorUserId: string;
  actorType: "client" | "admin";
  reason?: string;
}

export async function cancelChangeRequest(
  db: Database,
  input: CancelInput,
): Promise<CancelOutcome> {
  const rows = await db
    .select({
      id: changeRequests.id,
      publicId: changeRequests.publicId,
      title: changeRequests.title,
      status: changeRequests.status,
      organizationId: changeRequests.organizationId,
      allowanceId: changeRequests.allowanceId,
    })
    .from(changeRequests)
    .where(eq(changeRequests.id, input.requestId))
    .limit(1);

  const request = rows[0];
  if (!request) {
    return { ok: false, reason: "not_found", message: "We couldn't find that request." };
  }

  if (isTooLateToCancel(request.status)) {
    return {
      ok: false,
      reason: "already_live",
      message:
        "This change has already gone to your site, so it can't be called off. Send us a new request to undo it and we'll sort it out.",
    };
  }

  // Not an error worth alarming anyone with — the request is in the state the
  // client was asking for. Reported so the UI can stop offering the button.
  if (!isCancellable(request.status)) {
    return {
      ok: false,
      reason: "already_settled",
      message: "This request is already closed.",
    };
  }

  // The job carries the pull request, if the agent got that far. Newest first:
  // a request that was dispatched, failed and re-dispatched has more than one.
  const jobRows = await db
    .select({
      id: agentJobs.id,
      prNumber: agentJobs.prNumber,
      issueNumber: agentJobs.issueNumber,
      status: agentJobs.status,
      installationId: repositoryConnections.installationId,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      defaultBranch: repositoryConnections.defaultBranch,
    })
    .from(agentJobs)
    .leftJoin(
      repositoryConnections,
      eq(repositoryConnections.id, agentJobs.repositoryConnectionId),
    )
    .where(eq(agentJobs.requestId, request.id))
    .orderBy(desc(agentJobs.createdAt))
    .limit(1);

  const job = jobRows[0];

  await db
    .update(changeRequests)
    .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
    .where(eq(changeRequests.id, request.id));

  if (job) {
    await db
      .update(agentJobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentJobs.id, job.id));
  }

  // Always refunded, by policy: a client who changes their mind has not had a
  // change made, and charging them for one would be charging for nothing. The
  // work the agent may already have done is our cost, not theirs.
  let refunded = false;
  if (request.allowanceId) {
    await refundChange(db, request.allowanceId);
    refunded = true;
  }

  await db.insert(requestEvents).values({
    requestId: request.id,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    kind: "request_cancelled",
    body: input.reason?.trim()
      ? `Cancelled: ${input.reason.trim()}`
      : "Cancelled before it went live.",
    visibility: "client_visible",
  });

  await db.insert(auditLog).values({
    actorUserId: input.actorUserId,
    organizationId: request.organizationId,
    action: "request.cancelled",
    entityType: "change_request",
    entityId: request.publicId,
    metadata: {
      previousStatus: request.status,
      refunded,
      prNumber: job?.prNumber ?? null,
    },
  });

  const pullRequestClosed = await closeAbandonedPullRequest(db, request.id, job);

  return {
    ok: true,
    refunded,
    pullRequestClosed,
    message: refunded
      ? "Cancelled, and this month's change has been put back."
      : "Cancelled.",
  };
}

/**
 * Tidy up the pull request the agent opened, if there is one.
 *
 * Swallowed on failure for the reason given at the top of this file: the
 * cancellation is already recorded and must not be undone by GitHub being
 * unreachable. The failure is written to the internal timeline so it is
 * visible to an operator rather than only to a log nobody reads.
 */
async function closeAbandonedPullRequest(
  db: Database,
  requestId: string,
  job:
    | {
        prNumber: number | null;
        installationId: string | null;
        owner: string | null;
        name: string | null;
        defaultBranch: string | null;
      }
    | undefined,
): Promise<boolean> {
  if (!job?.prNumber || !job.installationId || !job.owner || !job.name) {
    return false;
  }

  const repo: Repo = {
    installationId: job.installationId,
    owner: job.owner,
    name: job.name,
  };

  try {
    // Comment first. If the close succeeds and the comment does not, the
    // repository is left with a pull request closed for no stated reason.
    await commentOnIssue(
      repo,
      job.prNumber,
      "Closing this — the client cancelled the change request it was raised for.",
    );

    // Read the branch name before closing: `head.ref` is only available from
    // the pull request itself, and `agent_jobs` records the SHA rather than the
    // ref it came from.
    const pr = await getPullRequest(repo, job.prNumber);
    const branch = pr.head?.ref ?? "";
    const defaultBranch = job.defaultBranch ?? pr.base?.ref ?? "";

    const result = await closePullRequest(repo, job.prNumber);

    // Then delete the branch the work sat on.
    //
    // A cancelled change that leaves its branch behind is the thing a client
    // asked us to stop being: a repository accumulating abandoned work, where
    // it is no longer obvious which branches describe the live site. The
    // commits remain reachable through the closed pull request on GitHub, so
    // this is tidying rather than destruction.
    let branchDeleted = false;
    if (branch && branch !== defaultBranch) {
      const removed = await deleteBranch(repo, branch, { defaultBranch });
      branchDeleted = removed.deleted;
    }

    await db.insert(requestEvents).values({
      requestId,
      actorType: "system",
      kind: result.closed ? "pull_request_closed" : "pull_request_close_skipped",
      body: [
        result.closed
          ? `Closed pull request #${job.prNumber}.`
          : `Pull request #${job.prNumber} was already closed (HTTP ${result.status}).`,
        branch
          ? branchDeleted
            ? `Deleted branch ${branch}.`
            : `Branch ${branch} was left in place.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
      visibility: "internal",
    });

    return result.closed;
  } catch (error) {
    console.error("[cancel] could not close the pull request", {
      requestId,
      prNumber: job.prNumber,
      message: error instanceof Error ? error.message : "unknown",
    });

    await db.insert(requestEvents).values({
      requestId,
      actorType: "system",
      kind: "pull_request_close_failed",
      body: `Pull request #${job.prNumber} is still open and needs closing by hand.`,
      visibility: "internal",
    });

    return false;
  }
}
