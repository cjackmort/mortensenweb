import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  repositoryConnections,
  requestEvents,
  sites,
} from "@/db/schema";
import { mergePullRequest, type Repo } from "@/lib/github/rest";
import {
  clientFacingRefusal,
  evaluateMerge,
  type RefusalReason,
} from "@/lib/github/merge-guard";

/**
 * Putting an approved change live.
 *
 * This is the last step of the loop and the only place in the platform where a
 * client's click leads to a write on their production website. Three things
 * shape it:
 *
 * **It lives in the admin repository directory.** A client route can call it —
 * that is the point of "Apply" — but it does so through a server action that
 * has already resolved and verified the tenant, and it takes the resolved job
 * rather than anything client-supplied. There is no parameter here a client
 * controls that could select a different repository.
 *
 * **The guard runs immediately before the merge, not at approval time.** Checks
 * can go red, commits can land, a pull request can be closed by hand in the
 * minutes between a client approving and the merge being attempted. Evaluating
 * at approval time and trusting it afterwards would be checking the wrong
 * moment.
 *
 * **The merge is pinned to the approved SHA.** GitHub refuses with 409 if the
 * branch moved. Between that and the guard's own `head_moved` check, the window
 * where something could change underneath us is closed rather than merely
 * narrow.
 */

export type ApplyOutcome =
  | { ok: true; mergeSha: string | undefined; message: string }
  | { ok: false; reason: RefusalReason | "not_ready" | "github_failed"; message: string };

export interface ApplyInput {
  agentJobId: string;
  /** The SHA the client approved. The merge is pinned to exactly this. */
  approvedHeadSha: string;
  allowedPaths?: string[];
  /** Who is applying: the client themselves, or an operator on their behalf. */
  actorUserId: string;
}

export async function applyApprovedChange(
  db: Database,
  input: ApplyInput,
): Promise<ApplyOutcome> {
  const rows = await db
    .select({
      id: agentJobs.id,
      publicId: agentJobs.publicId,
      requestId: agentJobs.requestId,
      prNumber: agentJobs.prNumber,
      headSha: agentJobs.headSha,
      baseRef: agentJobs.baseRef,
      status: agentJobs.status,
      decision: agentJobs.clientDecision,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      allowlisted: repositoryConnections.allowlisted,
      defaultBranch: repositoryConnections.defaultBranch,
      organizationId: sites.organizationId,
    })
    .from(agentJobs)
    .leftJoin(
      repositoryConnections,
      eq(repositoryConnections.id, agentJobs.repositoryConnectionId),
    )
    .leftJoin(sites, eq(sites.id, repositoryConnections.siteId))
    .where(eq(agentJobs.id, input.agentJobId))
    .limit(1);

  const job = rows[0];
  if (!job || !job.prNumber || !job.installationId || !job.owner || !job.name) {
    return {
      ok: false,
      reason: "not_ready",
      message: "This change isn't ready to go live yet.",
    };
  }

  // The allowlist is checked here as well as at dispatch and in the webhook.
  // Deliberate duplication: each of the three is a separate entry point to
  // writing a repository, and any one of them alone leaves a gap.
  if (!job.allowlisted) {
    return {
      ok: false,
      reason: "not_ready",
      message: "This site isn't set up for automatic updates.",
    };
  }

  if (job.decision !== "approved") {
    return {
      ok: false,
      reason: "not_approved",
      message: clientFacingRefusal("not_approved"),
    };
  }

  const repo: Repo = {
    installationId: job.installationId,
    owner: job.owner,
    name: job.name,
  };

  const decision = await evaluateMerge({
    repo,
    prNumber: job.prNumber,
    approvedHeadSha: input.approvedHeadSha,
    expectedBaseRef: job.baseRef ?? job.defaultBranch ?? "main",
    allowedPaths: input.allowedPaths,
    clientApproved: true,
  });

  if (!decision.ok) {
    // The operator gets the real reason; the client gets something they can act
    // on. Both are recorded, in their own visibility band.
    if (job.requestId) {
      await db.insert(requestEvents).values([
        {
          requestId: job.requestId,
          actorType: "system",
          kind: "merge_refused",
          body: decision.detail,
          visibility: "internal",
          metadata: { reason: decision.reason, prNumber: job.prNumber },
        },
        {
          requestId: job.requestId,
          actorType: "system",
          kind: "merge_held",
          body: clientFacingRefusal(decision.reason),
          visibility: "client_visible",
        },
      ]);

      // Checks still running is not a failure — it is "not yet". Marking the
      // request failed would tell the client something went wrong when the
      // build is simply mid-flight.
      if (decision.reason !== "checks_pending") {
        await db
          .update(changeRequests)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(changeRequests.id, job.requestId));
      }
    }

    return {
      ok: false,
      reason: decision.reason,
      message: clientFacingRefusal(decision.reason),
    };
  }

  const result = await mergePullRequest(repo, job.prNumber, {
    sha: decision.headSha,
    commitTitle: `Apply change ${job.publicId.slice(0, 8)}`,
    mergeMethod: "squash",
  });

  if (!result.merged) {
    // 405 (not mergeable) and 409 (head moved) come back here rather than as
    // exceptions. Both mean the same thing to a client: it did not go out.
    if (job.requestId) {
      await db.insert(requestEvents).values({
        requestId: job.requestId,
        actorType: "system",
        kind: "merge_failed",
        body: `GitHub refused the merge (HTTP ${result.status}): ${result.message ?? "no detail"}.`,
        visibility: "internal",
      });
    }
    return {
      ok: false,
      reason: "github_failed",
      message:
        "We couldn't put this live just now. We've been notified and will sort it out.",
    };
  }

  const now = new Date();

  await db
    .update(agentJobs)
    .set({
      status: "merged",
      mergedAt: now,
      mergeCommitSha: result.sha ?? null,
      finishedAt: now,
    })
    .where(eq(agentJobs.id, job.id));

  if (job.requestId) {
    // `merged`, not `deployed`. The deployment webhook moves it on when the
    // production build actually finishes — claiming "live" at merge time would
    // be a promise about a build that has not run.
    await db
      .update(changeRequests)
      .set({ status: "merged", updatedAt: now })
      .where(eq(changeRequests.id, job.requestId));

    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "system",
      kind: "change_applied",
      body: "Your change has been applied and is going live now.",
      visibility: "client_visible",
    });
  }

  await db.insert(auditLog).values({
    actorUserId: input.actorUserId,
    organizationId: job.organizationId ?? null,
    action: "agent_job.merged",
    entityType: "agent_job",
    entityId: job.publicId,
    metadata: {
      repository: `${job.owner}/${job.name}`,
      prNumber: job.prNumber,
      headSha: decision.headSha,
      mergeSha: result.sha,
      changedFiles: decision.changedFiles.length,
    },
  });

  return {
    ok: true,
    mergeSha: result.sha,
    message: "Your change is on its way to your live site.",
  };
}
