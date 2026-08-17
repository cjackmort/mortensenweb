import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  dispatchQuotas,
  repositoryConnections,
  requestEvents,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  createIssue,
  type Repo,
} from "@/lib/github/rest";
import {
  renderIssueBody,
  renderIssueTitle,
  scanForInjection,
} from "@/lib/github/issue";
import { isGithubConfigured } from "@/lib/github/app";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Dispatching a change request to the automation pipeline.
 *
 * Only an admin can reach this. The client's role ends at submitting the
 * request — nothing a client can do causes a repository to be written to, which
 * is why this lives in the admin repository directory rather than behind a role
 * check inside a shared one.
 */

const DEFAULT_CAP = 10;
const DEFAULT_TIMEOUT_MINUTES = 30;

/** Statuses from which starting work is meaningful. */
const DISPATCHABLE = new Set(["submitted", "triaged", "approved"]);

// ---------------------------------------------------------------------------
// Daily quota
// ---------------------------------------------------------------------------

/**
 * Today, in the business timezone.
 *
 * A UTC day boundary would roll the quota over mid-afternoon in Denver, so the
 * cap would not mean "ten dispatches in a working day", which is what it is for.
 */
function businessDay(now = new Date()): string {
  const timeZone = process.env.BUSINESS_TIMEZONE ?? "America/Denver";
  // en-CA formats as YYYY-MM-DD, which is what the `date` column wants.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface QuotaDecision {
  granted: boolean;
  count: number;
  cap: number;
}

/**
 * Claim one dispatch against today's cap.
 *
 * The increment and the limit check are a **single statement**. Doing this as
 * `SELECT count` then `UPDATE` would let two approvals a few milliseconds apart
 * both read nine and both write ten — the cap exists to bound Actions minutes
 * on private repositories, so a cap that leaks under concurrency is not a cap.
 *
 * `setWhere` is what makes it atomic: when the row is already at its cap the
 * update matches nothing, returns no rows, and the caller is refused.
 */
export async function claimDispatchSlot(
  db: Database,
  scope = "global",
): Promise<QuotaDecision> {
  const cap = Number(process.env.AGENT_DAILY_DISPATCH_CAP ?? DEFAULT_CAP);
  const day = businessDay();

  const claimed = await db
    .insert(dispatchQuotas)
    .values({ day, scope, count: 1, cap })
    .onConflictDoUpdate({
      target: [dispatchQuotas.day, dispatchQuotas.scope],
      set: { count: sql`${dispatchQuotas.count} + 1` },
      setWhere: sql`${dispatchQuotas.count} < ${dispatchQuotas.cap}`,
    })
    .returning({ count: dispatchQuotas.count, cap: dispatchQuotas.cap });

  if (claimed.length > 0) {
    return { granted: true, count: claimed[0]!.count, cap: claimed[0]!.cap };
  }

  // Refused. Report the real numbers so the admin UI can say how many are left
  // rather than "try again later".
  const current = await db
    .select({ count: dispatchQuotas.count, cap: dispatchQuotas.cap })
    .from(dispatchQuotas)
    .where(and(eq(dispatchQuotas.day, day), eq(dispatchQuotas.scope, scope)));

  return {
    granted: false,
    count: current[0]?.count ?? cap,
    cap: current[0]?.cap ?? cap,
  };
}

/**
 * Hand a claimed slot back.
 *
 * Called when a dispatch fails before any workflow could run. A failed issue
 * creation consumed no Actions minutes, so charging it against the day's budget
 * would let a misconfigured repository exhaust the cap without doing any work.
 * Floored at zero because the table has a non-negative check constraint.
 */
export async function releaseDispatchSlot(
  db: Database,
  scope = "global",
): Promise<void> {
  await db
    .update(dispatchQuotas)
    .set({ count: sql`GREATEST(${dispatchQuotas.count} - 1, 0)` })
    .where(
      and(eq(dispatchQuotas.day, businessDay()), eq(dispatchQuotas.scope, scope)),
    );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type DispatchOutcome =
  | { ok: true; agentJobPublicId: string; issueNumber: number; issueUrl: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "wrong_status"
        | "no_repository"
        | "not_allowlisted"
        | "not_configured"
        | "quota_exhausted"
        | "github_failed";
      message: string;
      quota?: QuotaDecision;
    };

/**
 * Resolve the repository a request should be worked in.
 *
 * A request without a site, a site without a repository connection, or a
 * connection that has not been allowlisted all stop the pipeline here. The
 * allowlist is a per-repository opt-in and is checked on both ends — dispatch
 * and webhook — because either alone leaves a gap.
 */
async function resolveRepo(db: Database, siteId: string | null) {
  if (!siteId) return null;

  const rows = await db
    .select({
      connectionId: repositoryConnections.id,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      defaultBranch: repositoryConnections.defaultBranch,
      allowlisted: repositoryConnections.allowlisted,
    })
    .from(repositoryConnections)
    .where(eq(repositoryConnections.siteId, siteId))
    .limit(1);

  return rows[0] ?? null;
}

export interface DispatchInput {
  requestPublicId: string;
  /** Narrow the agent's scope. Also becomes the merge guard's allowed paths. */
  allowedPaths?: string[];
  /** Short-lived signed attachment URLs, generated by the caller. */
  attachmentUrls?: string[];
}

export async function dispatchChangeRequest(
  ctx: AdminContext,
  db: Database,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "The GitHub App is not configured in this environment.",
    };
  }

  const requests = await db
    .select({
      id: changeRequests.id,
      publicId: changeRequests.publicId,
      organizationId: changeRequests.organizationId,
      siteId: changeRequests.siteId,
      title: changeRequests.title,
      description: changeRequests.description,
      category: changeRequests.category,
      priority: changeRequests.priority,
      desiredTiming: changeRequests.desiredTiming,
      status: changeRequests.status,
    })
    .from(changeRequests)
    .where(eq(changeRequests.publicId, input.requestPublicId))
    .limit(1);

  const request = requests[0];
  if (!request) throw new NotFoundError();

  if (!DISPATCHABLE.has(request.status)) {
    return {
      ok: false,
      reason: "wrong_status",
      message: `This request is "${request.status}" and cannot be started again.`,
    };
  }

  const repo = await resolveRepo(db, request.siteId);
  if (!repo || !repo.installationId) {
    return {
      ok: false,
      reason: "no_repository",
      message:
        "This request's site has no connected repository, so there is nothing to change.",
    };
  }
  if (!repo.allowlisted) {
    return {
      ok: false,
      reason: "not_allowlisted",
      message: `${repo.owner}/${repo.name} is not allowlisted for automation.`,
    };
  }

  // Per-repository scope, so one busy client cannot consume the whole day.
  const scope = `${repo.owner}/${repo.name}`;
  const quota = await claimDispatchSlot(db, scope);
  if (!quota.granted) {
    return {
      ok: false,
      reason: "quota_exhausted",
      message: `Daily automation limit reached for this repository (${quota.count}/${quota.cap}).`,
      quota,
    };
  }

  // The job row is written *before* the issue exists, because its public id is
  // the marker embedded in the issue body. Creating the issue first would leave
  // no way to correlate the webhook that may arrive before we finish writing.
  const agentJobPublicId = newPublicId();
  const timeoutMinutes = Number(
    process.env.AGENT_JOB_TIMEOUT_MINUTES ?? DEFAULT_TIMEOUT_MINUTES,
  );

  const inserted = await db
    .insert(agentJobs)
    .values({
      publicId: agentJobPublicId,
      requestId: request.id,
      repositoryConnectionId: repo.connectionId,
      baseRef: repo.defaultBranch,
      status: "queued",
      timeoutAt: new Date(Date.now() + timeoutMinutes * 60_000),
    })
    .returning({ id: agentJobs.id });

  const agentJobId = inserted[0]!.id;

  // Recorded, never acted on. §13.2: text that looks like an instruction is
  // surfaced to the operator rather than filtered out of the client's words.
  const findings = scanForInjection(
    `${request.title}\n${request.description ?? ""}`,
  );

  const target: Repo = {
    installationId: repo.installationId,
    owner: repo.owner,
    name: repo.name,
  };

  let issue: { number: number; html_url: string };
  try {
    issue = await createIssue(target, {
      title: renderIssueTitle(request.publicId, request.title),
      body: renderIssueBody({
        requestPublicId: request.publicId,
        agentJobPublicId,
        title: request.title,
        description: request.description,
        category: request.category,
        priority: request.priority,
        desiredTiming: request.desiredTiming,
        attachmentUrls: input.attachmentUrls,
        allowedPaths: input.allowedPaths,
      }),
      labels: ["portal-request", "claude"],
    });
  } catch (error) {
    await db
      .update(agentJobs)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
        finishedAt: new Date(),
      })
      .where(eq(agentJobs.id, agentJobId));

    await releaseDispatchSlot(db, scope);

    return {
      ok: false,
      reason: "github_failed",
      message: "Could not open the issue in the repository. Nothing was started.",
    };
  }

  const now = new Date();

  await db
    .update(agentJobs)
    .set({
      issueNumber: issue.number,
      status: "dispatched",
      dispatchedAt: now,
    })
    .where(eq(agentJobs.id, agentJobId));

  await db
    .update(changeRequests)
    .set({ status: "dispatched", updatedAt: now })
    .where(eq(changeRequests.id, request.id));

  // Two timeline rows, two audiences. The client sees plain language; the
  // internal row keeps the repository and issue number out of their view.
  await db.insert(requestEvents).values([
    {
      requestId: request.id,
      actorType: "system",
      kind: "work_started",
      body: "We've started work on this.",
      visibility: "client_visible",
    },
    {
      requestId: request.id,
      actorType: "system",
      kind: "agent_dispatched",
      body: `Issue #${issue.number} opened in ${scope}.`,
      visibility: "internal",
      metadata: {
        agentJobPublicId,
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        repository: scope,
        quota: { count: quota.count, cap: quota.cap },
        ...(findings.length ? { injectionFindings: findings } : {}),
      },
    },
  ]);

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: request.organizationId,
    action: "agent_job.dispatched",
    entityType: "change_request",
    entityId: request.publicId,
    metadata: { agentJobPublicId, repository: scope, issueNumber: issue.number },
  });

  return {
    ok: true,
    agentJobPublicId,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
  };
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

/**
 * Fail jobs that were dispatched and never reported back.
 *
 * Without this a workflow that dies — a runner outage, a repository whose
 * workflow file is missing, a run cancelled by hand — leaves the request stuck
 * on "being worked on" forever, and the client is told work is happening when
 * nothing is. Intended to be run on a schedule.
 */
export async function expireStalledJobs(db: Database): Promise<number> {
  const now = new Date();

  const stalled = await db
    .select({ id: agentJobs.id, requestId: agentJobs.requestId })
    .from(agentJobs)
    .where(
      and(
        sql`${agentJobs.status} IN ('queued', 'dispatched', 'running')`,
        sql`${agentJobs.timeoutAt} IS NOT NULL AND ${agentJobs.timeoutAt} < ${now}`,
      ),
    );

  for (const job of stalled) {
    await db
      .update(agentJobs)
      .set({
        status: "timed_out",
        error: "No result reported before the timeout.",
        finishedAt: now,
      })
      .where(eq(agentJobs.id, job.id));

    if (!job.requestId) continue;

    await db
      .update(changeRequests)
      .set({ status: "failed", updatedAt: now })
      .where(eq(changeRequests.id, job.requestId));

    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "system",
      kind: "agent_timed_out",
      body: "Automation did not finish in time; this needs a look.",
      visibility: "internal",
    });
  }

  return stalled.length;
}

/** Look up a job by the marker embedded in an issue or PR body. */
export async function findAgentJobByPublicId(db: Database, publicId: string) {
  const rows = await db
    .select({
      id: agentJobs.id,
      publicId: agentJobs.publicId,
      requestId: agentJobs.requestId,
      repositoryConnectionId: agentJobs.repositoryConnectionId,
      issueNumber: agentJobs.issueNumber,
      prNumber: agentJobs.prNumber,
      headSha: agentJobs.headSha,
      baseRef: agentJobs.baseRef,
      status: agentJobs.status,
    })
    .from(agentJobs)
    .where(eq(agentJobs.publicId, publicId))
    .limit(1);

  return rows[0] ?? null;
}

/** Sites belonging to a repository connection, for webhook correlation. */
export async function repoConnectionByNodeId(db: Database, nodeId: string) {
  const rows = await db
    .select({
      id: repositoryConnections.id,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      defaultBranch: repositoryConnections.defaultBranch,
      allowlisted: repositoryConnections.allowlisted,
      siteId: repositoryConnections.siteId,
    })
    .from(repositoryConnections)
    .leftJoin(sites, eq(sites.id, repositoryConnections.siteId))
    .where(eq(repositoryConnections.repoNodeId, nodeId))
    .limit(1);

  return rows[0] ?? null;
}
