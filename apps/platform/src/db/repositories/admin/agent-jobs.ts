import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  changeRequests,
  dispatchQuotas,
  repositoryConnections,
  mediaAssets,
  requestAssets,
  requestAttachments,
  requestEvents,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { notifyClientOfRequest } from "@/lib/notify/request";
import { refundChange } from "@/db/repositories/client/entitlements";
import {
  createIssue,
  type Repo,
} from "@/lib/github/rest";
import {
  renderIssueBody,
  renderIssueTitle,
  scanForInjection,
  sizeLabel,
} from "@/lib/github/issue";
import { isGithubConfigured } from "@/lib/github/app";
import { attachmentUrl, mediaAssetUrl } from "@/lib/storage/signed-links";
import { snapshotRequestAssets } from "@/db/repositories/client/request-assets";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Dispatching a change request to the automation pipeline.
 *
 * Two entry points, one code path. An operator dispatches through
 * `dispatchChangeRequest`; where `AGENT_AUTO_DISPATCH` is enabled, a submission
 * dispatches itself through `autoDispatchIfEnabled`. The admin session was only
 * ever read to attribute the audit row, never to decide anything, so the
 * unattended entry point takes no context rather than a weakened one.
 *
 * That flag does change the security story and it is worth stating plainly:
 * with it on, a client submitting a request causes a repository to be written
 * to with nobody in between. What stands between them and that repository is
 * unchanged — the per-repository allowlist, the daily cap, and the injection
 * containment in the issue renderer — and the flag itself is off unless its
 * value is exactly "true", so a half-written deploy configuration leaves the
 * operator in the loop rather than out of it.
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
  attachmentUrls?: AttachmentLink[];
}

/**
 * Who a dispatch is attributed to.
 *
 * Attribution, not authorisation: nothing below branches on the actor except
 * the audit row it writes. Keeping the two entry points on one implementation
 * is the point — a second copy of this function for the unattended case is
 * exactly how a repository ends up allowlisted on one path and not the other.
 */
/**
 * Signed, expiring links for every image on a request.
 *
 * Ordered by upload time so the numbering in the issue body matches the order
 * the client attached them — they will refer to "the second photo", and the
 * agent should be looking at the same one.
 *
 * Attachments a scanner has flagged are excluded here as well as at the serving
 * route. Minting a link that is guaranteed to 404 wastes the agent's time and
 * makes a deliberate refusal look like a broken system.
 */
export interface AttachmentLink {
  url: string;
  title: string | null;
  caption: string | null;
  /**
   * Context the agent needs to place an image well, and which it previously
   * had no way to know.
   *
   * Dimensions let it decide whether a photo can carry a full-width hero or
   * belongs beside text — the alternative is downloading it to find out, or
   * guessing. The folder path carries the client's own organisation of their
   * work: "Winter Series" beside a painting says something a filename does not.
   */
  width?: number | null;
  height?: number | null;
  folderPath?: string | null;
}

async function attachmentLinksFor(
  db: Database,
  requestId: string,
): Promise<AttachmentLink[] | undefined> {
  const rows = await db
    .select({
      publicId: requestAttachments.publicId,
      scanStatus: requestAttachments.scanStatus,
      title: requestAttachments.title,
      caption: requestAttachments.caption,
      filename: requestAttachments.filenameOriginal,
    })
    .from(requestAttachments)
    .where(eq(requestAttachments.requestId, requestId))
    .orderBy(requestAttachments.createdAt);

  const links: AttachmentLink[] = [];
  for (const row of rows) {
    if (row.scanStatus === "flagged") continue;
    const url = await attachmentUrl(row.publicId);
    if (!url) continue;
    links.push({
      url,
      // Falls back to the filename so an untitled photo is still referable —
      // "Attachment 1" gave the agent nothing to match a request against.
      title: row.title?.trim() || row.filename?.trim() || null,
      caption: row.caption?.trim() || null,
    });
  }

  return links.length > 0 ? links : undefined;
}

/**
 * Signed links for the media-library images a request selected.
 *
 * `snapshotRequestAssets` runs first and is the whole point of the ordering:
 * the titles, descriptions, dimensions and folder paths handed to the agent are
 * frozen at this moment. A client who reorganises their library afterwards
 * changes nothing about a job already dispatched — which is what stops tidying
 * up from silently rewriting a brief someone is already working from.
 *
 * The links themselves point at originals, because the agent is producing the
 * site's own optimised assets and a thumbnail is the wrong input for that.
 */
async function mediaAssetLinksFor(
  db: Database,
  requestId: string,
): Promise<AttachmentLink[] | undefined> {
  await snapshotRequestAssets(db, requestId);

  const rows = await db
    .select({
      publicId: mediaAssets.publicId,
      status: mediaAssets.status,
      deletedAt: mediaAssets.deletedAt,
      title: requestAssets.snapshotTitle,
      description: requestAssets.snapshotDescription,
      folderPath: requestAssets.snapshotFolderPath,
      width: requestAssets.snapshotWidth,
      height: requestAssets.snapshotHeight,
      position: requestAssets.position,
    })
    .from(requestAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.id, requestAssets.assetId))
    .where(eq(requestAssets.requestId, requestId))
    .orderBy(requestAssets.position);

  const links: AttachmentLink[] = [];
  for (const row of rows) {
    // Deleted or not-yet-ready assets are skipped rather than linked. A link
    // guaranteed to 404 wastes the agent's run and makes a deliberate refusal
    // look like a broken system.
    if (row.deletedAt !== null || row.status !== "ready") continue;
    const url = await mediaAssetUrl(row.publicId);
    if (!url) continue;
    links.push({
      url,
      title: row.title,
      caption: row.description,
      width: row.width,
      height: row.height,
      folderPath: row.folderPath,
    });
  }

  return links.length > 0 ? links : undefined;
}

type DispatchActor = { automatic: false; userId: string } | { automatic: true };

async function runDispatch(
  db: Database,
  input: DispatchInput,
  actor: DispatchActor,
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

  // The client's photos, as links the agent can actually fetch.
  //
  // Resolved here rather than accepted from the caller, so both entry points —
  // the operator's button and automatic dispatch — carry them without either
  // having to remember. `input.attachmentUrls` still wins when supplied, which
  // keeps the parameter useful for a caller that has already minted links.
  //
  // A signing failure yields no links rather than broken ones: an issue whose
  // attachment section 404s is worse than one that plainly has no photos,
  // because the agent will describe what it could not see rather than asking.
  // Both sources, in one list: images chosen from the media library, and any
  // photos attached inline by the older request form. The agent does not need
  // to know which route an image took to get here, and a request made during
  // the transition can legitimately carry both.
  //
  // Media assets come first because they carry dimensions and folder context,
  // so the better-described images are the ones the agent reads about first.
  const mediaLinks = input.attachmentUrls
    ? undefined
    : await mediaAssetLinksFor(db, request.id);
  const legacyLinks = input.attachmentUrls
    ? undefined
    : await attachmentLinksFor(db, request.id);

  const attachmentUrls =
    input.attachmentUrls ??
    (() => {
      const combined = [
        ...(mediaLinks ?? []),
        ...(legacyLinks ?? []),
      ];
      return combined.length > 0 ? combined : undefined;
    })();

  // Anything the client added since sending. Empty on a first dispatch;
  // on a re-dispatch after "ask for changes" it is often the whole point.
  const clientNotes = (
    await db
      .select({ body: requestEvents.body })
      .from(requestEvents)
      .where(
        and(
          eq(requestEvents.requestId, request.id),
          eq(requestEvents.kind, "client_note"),
        ),
      )
      .orderBy(requestEvents.createdAt)
  )
    .map((e) => e.body?.trim() ?? "")
    .filter(Boolean);

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
        attachmentUrls,
        allowedPaths: input.allowedPaths,
        clientNotes,
      }),
      labels: [
        "portal-request",
        "claude",
        sizeLabel({
          title: request.title,
          description: request.description,
          attachmentCount: attachmentUrls?.length ?? 0,
        }),
      ],
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

  // A null actor is the system, and the metadata says so rather than leaving
  // "who started this?" to be inferred from an absence.
  await db.insert(auditLog).values({
    actorUserId: actor.automatic ? null : actor.userId,
    organizationId: request.organizationId,
    action: "agent_job.dispatched",
    entityType: "change_request",
    entityId: request.publicId,
    metadata: {
      agentJobPublicId,
      repository: scope,
      issueNumber: issue.number,
      ...(actor.automatic ? { automatic: true } : {}),
    },
  });

  return {
    ok: true,
    agentJobPublicId,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
  };
}

/** Dispatch on an operator's instruction. */
export async function dispatchChangeRequest(
  ctx: AdminContext,
  db: Database,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  return runDispatch(db, input, { automatic: false, userId: ctx.userId });
}

// ---------------------------------------------------------------------------
// Automatic dispatch
// ---------------------------------------------------------------------------

export type AutoDispatchOutcome =
  | DispatchOutcome
  | { ok: false; reason: "disabled"; message: string };

/**
 * Whether a submission dispatches itself.
 *
 * Exactly `"true"`, so unset, empty, `"1"`, and `"TRUE"` are all off. A looser
 * test would turn a typo in a deploy configuration into unattended writes to
 * client repositories, and the failure would be silent in the direction that
 * matters — nobody notices automation they did not ask for until it has run.
 */
export function isAutoDispatchEnabled(): boolean {
  return process.env.AGENT_AUTO_DISPATCH === "true";
}

/**
 * Dispatch a freshly submitted request, where the operator has opted in.
 *
 * No `AdminContext`, because there is no session behind this: the request was
 * submitted by a client and nobody approved the dispatch. `disabled` is
 * separated from the refusals so a caller can stay quiet about a flag that is
 * simply off, which is most environments most of the time.
 */
export async function autoDispatchIfEnabled(
  db: Database,
  requestPublicId: string,
): Promise<AutoDispatchOutcome> {
  if (!isAutoDispatchEnabled()) {
    return {
      ok: false,
      reason: "disabled",
      message: "Automatic dispatch is not enabled in this environment.",
    };
  }

  return runDispatch(db, { requestPublicId }, { automatic: true });
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
    .select({
      id: agentJobs.id,
      requestId: agentJobs.requestId,
      allowanceId: changeRequests.allowanceId,
    })
    .from(agentJobs)
    .leftJoin(changeRequests, eq(changeRequests.id, agentJobs.requestId))
    .where(
      and(
        sql`${agentJobs.status} IN ('queued', 'dispatched', 'running')`,
        sql`${agentJobs.timeoutAt} IS NOT NULL AND ${agentJobs.timeoutAt} < ${now}`,
      ),
    );

  for (const job of stalled) {
    await reclaimJob(db, job, now, "system");
  }

  return stalled.length;
}

/**
 * Put one stalled job, and the request behind it, back into a state a person
 * can act on.
 *
 * Extracted from `expireStalledJobs` so the operator can do by hand exactly
 * what the schedule does unattended — the same writes, the same refund, the
 * same client notification. Two code paths that "both fail a job" would drift,
 * and the manual one is used precisely when the automatic one is already not
 * working, which is the worst moment to discover a difference.
 */
async function reclaimJob(
  db: Database,
  job: { id: string; requestId: string | null; allowanceId: string | null },
  now: Date,
  actor: "system" | "admin",
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      status: "timed_out",
      error:
        actor === "admin"
          ? "Reclaimed by an operator after the timeout passed."
          : "No result reported before the timeout.",
      finishedAt: now,
    })
    .where(eq(agentJobs.id, job.id));

  if (!job.requestId) return;

  await db
    .update(changeRequests)
    .set({ status: "failed", updatedAt: now })
    .where(eq(changeRequests.id, job.requestId));

  await db.insert(requestEvents).values({
    requestId: job.requestId,
    actorType: actor === "admin" ? "admin" : "system",
    kind: "agent_timed_out",
    body: "Automation did not finish in time; this needs a look.",
    visibility: "internal",
  });

  // A failure on our side is not a change the client received, so it is not
  // one they used. Cancelling already refunds by policy; a timeout is the
  // same situation without the client having asked for it.
  if (job.allowanceId) {
    await refundChange(db, job.allowanceId);
    await db
      .update(changeRequests)
      .set({ allowanceId: null })
      .where(eq(changeRequests.id, job.requestId));
  }

  await notifyClientOfRequest(db, job.requestId, "snag");
}

export type ReclaimOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_overdue"; message: string };

/**
 * The operator's copy of the watchdog, for one request.
 *
 * The watchdog is an automation and automations stop. When this one did, a
 * request sat on "being worked on" for eight hours with no control offered
 * anywhere: the queue hides "Start work" once a request is dispatched, and
 * hides "Close" too, because closing would not stop a run that is genuinely in
 * flight. Correct for a live run, a trap for a dead one — there was no way out
 * of it from the interface at all.
 *
 * Still refuses a run that has not passed its timeout. This reclaims something
 * already declared late; it is not a kill switch for work in progress, which
 * would leave a live agent writing to a branch nobody is watching.
 */
export async function reclaimStalledRequest(
  _ctx: AdminContext,
  db: Database,
  requestPublicId: string,
): Promise<ReclaimOutcome> {
  const now = new Date();

  const rows = await db
    .select({
      id: agentJobs.id,
      requestId: agentJobs.requestId,
      timeoutAt: agentJobs.timeoutAt,
      status: agentJobs.status,
      allowanceId: changeRequests.allowanceId,
    })
    .from(agentJobs)
    .innerJoin(changeRequests, eq(changeRequests.id, agentJobs.requestId))
    .where(eq(changeRequests.publicId, requestPublicId))
    .orderBy(desc(agentJobs.createdAt))
    .limit(1);

  const job = rows[0];
  if (!job) {
    return {
      ok: false,
      reason: "not_found",
      message: "There is no agent run against this request.",
    };
  }

  if (!["queued", "dispatched", "running"].includes(job.status)) {
    return {
      ok: false,
      reason: "not_overdue",
      message: `That run already finished as "${job.status}".`,
    };
  }

  if (!job.timeoutAt || job.timeoutAt.getTime() > now.getTime()) {
    return {
      ok: false,
      reason: "not_overdue",
      message:
        "That run has not passed its timeout yet. Give it until then — " +
        "reclaiming a live run leaves the agent writing to a branch nobody " +
        "is watching.",
    };
  }

  await reclaimJob(db, job, now, "admin");
  return { ok: true };
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

/**
 * Close a request without doing it.
 *
 * Tests, duplicates, things a client changed their mind about, anything raised
 * by mistake. Until now a request could only leave the open list by being
 * carried out, so the operator's own trial runs sat at the top of the queue
 * indefinitely.
 *
 * Closed, not deleted. A change request is the client's record of something
 * they asked for, and its events and any agent job hang off it — removing the
 * row would take that history with it, and "I asked for this and it vanished"
 * is a much worse conversation than "that one was closed". It leaves the open
 * list either way, which is the actual complaint.
 *
 * Refuses anything already dispatched. Work is in flight at that point, and
 * closing the request here would not stop it — it would only mean nobody is
 * watching when the pull request opens.
 */
export async function closeChangeRequest(
  ctx: AdminContext,
  db: Database,
  requestPublicId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "in_flight" }> {
  const rows = await db
    .select({
      id: changeRequests.id,
      organizationId: changeRequests.organizationId,
      status: changeRequests.status,
    })
    .from(changeRequests)
    .where(eq(changeRequests.publicId, requestPublicId))
    .limit(1);

  const request = rows[0];
  if (!request) return { ok: false, reason: "not_found" };

  if (["dispatched", "in_progress", "pr_open"].includes(request.status)) {
    return { ok: false, reason: "in_flight" };
  }

  await db
    .update(changeRequests)
    .set({ status: "closed", updatedAt: new Date() })
    .where(eq(changeRequests.id, request.id));

  // Client-visible: they raised it, so they are entitled to see it closed and
  // why, rather than finding it silently gone from their list.
  await db.insert(requestEvents).values({
    requestId: request.id,
    actorType: "admin",
    actorUserId: ctx.userId,
    kind: "request_closed",
    body: reason || "Closed without action.",
    visibility: "client_visible",
  });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: request.organizationId,
    action: "request.closed",
    entityType: "change_request",
    entityId: requestPublicId,
    metadata: { previousStatus: request.status, reason: reason || null },
  });

  return { ok: true };
}

/**
 * Dispatch requests that are waiting, on a schedule.
 *
 * Auto-dispatch used to run inside the client's submit action. Opening a GitHub
 * issue is a network round trip, and doing it there put it in the same
 * ten-second function budget as the blob uploads — together they were enough to
 * time the request out, so a client whose submission had in fact been saved saw
 * a connection error and typed it all again.
 *
 * Moving it here costs at most five minutes of delay and nothing else: a
 * preview has to be built and then reviewed by an operator before the client
 * sees it either way.
 *
 * Bounded per run. The daily cap inside `runDispatch` is the real backstop;
 * this limit only stops one tick trying to open forty issues inside a function
 * timeout, which is the failure it was created to remove.
 */
export async function dispatchSubmittedRequests(
  db: Database,
  { limit = 5 }: { limit?: number } = {},
): Promise<{ dispatched: number; refused: number }> {
  if (!isAutoDispatchEnabled()) return { dispatched: 0, refused: 0 };

  const waiting = await db
    .select({ publicId: changeRequests.publicId })
    .from(changeRequests)
    .where(eq(changeRequests.status, "submitted"))
    .orderBy(changeRequests.createdAt)
    .limit(limit);

  let dispatched = 0;
  let refused = 0;

  for (const request of waiting) {
    try {
      const outcome = await runDispatch(db, { requestPublicId: request.publicId }, { automatic: true });
      if (outcome.ok) dispatched += 1;
      else refused += 1;
    } catch (error) {
      // One unreachable repository must not stop the rest of the batch.
      refused += 1;
      console.error("[dispatch] scheduled dispatch failed", {
        requestPublicId: request.publicId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return { dispatched, refused };
}
