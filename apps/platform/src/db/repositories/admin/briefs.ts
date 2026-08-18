import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  auditLog,
  clients,
  repositoryConnections,
  siteBriefs,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { createIssue, type Repo } from "@/lib/github/rest";
import {
  renderBriefIssueBody,
  renderBriefIssueTitle,
  scanForInjection,
} from "@/lib/github/issue";
import { isGithubConfigured } from "@/lib/github/app";
import { claimDispatchSlot, releaseDispatchSlot } from "./agent-jobs";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Briefs — what the operator writes down after a call.
 *
 * The step the process describes as "type the wanted features, colour theme and
 * so on into a box, and hit submit at the end of the call". Underneath, a brief
 * is a small record with a lifecycle, because the text becomes an agent's
 * instructions and anything that becomes instructions needs to be auditable.
 *
 * Draft → submitted → dispatched → applied. Writing and dispatching are
 * deliberately two steps: a call runs long, notes get typed in pieces, and the
 * operator should be able to save halfway through without starting an automated
 * build of somebody's website by accident.
 */

export interface BriefInput {
  organizationId: string;
  sitePublicId?: string;
  kind: "discovery" | "revision";
  colourDirection?: string;
  features?: string;
  contentNotes?: string;
  body?: string;
}

function hasContent(input: BriefInput): boolean {
  return Boolean(
    (input.colourDirection ?? "").trim() ||
      (input.features ?? "").trim() ||
      (input.contentNotes ?? "").trim() ||
      (input.body ?? "").trim(),
  );
}

export type SaveBriefResult =
  | { ok: true; publicId: string }
  | { ok: false; reason: "empty" | "site_not_found"; message: string };

/**
 * Save a brief, as a draft or submitted.
 *
 * `submit: false` is the "we're still on the call" path. The schema refuses a
 * non-draft brief without a `submittedAt`, so the two states cannot drift.
 */
export async function saveBrief(
  ctx: AdminContext,
  db: Database,
  input: BriefInput,
  { submit }: { submit: boolean },
): Promise<SaveBriefResult> {
  if (!hasContent(input)) {
    return {
      ok: false,
      reason: "empty",
      message: "A brief needs at least one note in it.",
    };
  }

  let siteId: string | null = null;
  if (input.sitePublicId) {
    const rows = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.publicId, input.sitePublicId),
          // The site must belong to the organization the brief is for, or a
          // mistyped id would attach one client's brief to another's site.
          eq(sites.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      return {
        ok: false,
        reason: "site_not_found",
        message: "That site does not belong to this client.",
      };
    }
    siteId = rows[0].id;
  }

  const publicId = newPublicId();
  const now = new Date();

  await db.insert(siteBriefs).values({
    publicId,
    organizationId: input.organizationId,
    siteId,
    kind: input.kind,
    status: submit ? "submitted" : "draft",
    colourDirection: input.colourDirection?.trim() || null,
    features: input.features?.trim() || null,
    contentNotes: input.contentNotes?.trim() || null,
    body: input.body?.trim() || null,
    authoredByUserId: ctx.userId,
    submittedAt: submit ? now : null,
  });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: input.organizationId,
    action: submit ? "brief.submitted" : "brief.drafted",
    entityType: "site_brief",
    entityId: publicId,
    metadata: { kind: input.kind },
  });

  return { ok: true, publicId };
}

export type BriefDispatchOutcome =
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
    };

/**
 * Hand a submitted brief to the agent.
 *
 * Mirrors `dispatchChangeRequest` closely and on purpose — same quota, same
 * ordering (job row before issue, because its id is the marker in the body),
 * same refusal-as-value error handling. Two dispatch paths that behave
 * differently under the same failure would be two sets of operational
 * behaviour to learn.
 */
export interface BriefContext {
  /**
   * Facts the operator confirmed, and the business's existing site.
   *
   * Passed in rather than looked up here: at concept time a prospect has no
   * link to an organization — that relation only exists after conversion — so
   * only the caller holding the prospect can resolve them.
   */
  verifiedFacts?: { key: string; value: string }[];
  sourceWebsiteUrl?: string | null;
}

export async function dispatchBrief(
  ctx: AdminContext,
  db: Database,
  briefPublicId: string,
  context: BriefContext = {},
): Promise<BriefDispatchOutcome> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "The GitHub App is not configured in this environment.",
    };
  }

  const rows = await db
    .select({
      id: siteBriefs.id,
      publicId: siteBriefs.publicId,
      organizationId: siteBriefs.organizationId,
      siteId: siteBriefs.siteId,
      kind: siteBriefs.kind,
      status: siteBriefs.status,
      colourDirection: siteBriefs.colourDirection,
      features: siteBriefs.features,
      contentNotes: siteBriefs.contentNotes,
      body: siteBriefs.body,
      businessName: sites.name,
      connectionId: repositoryConnections.id,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      defaultBranch: repositoryConnections.defaultBranch,
      allowlisted: repositoryConnections.allowlisted,
    })
    .from(siteBriefs)
    .leftJoin(sites, eq(sites.id, siteBriefs.siteId))
    .leftJoin(repositoryConnections, eq(repositoryConnections.siteId, sites.id))
    .where(eq(siteBriefs.publicId, briefPublicId))
    .limit(1);

  const brief = rows[0];
  if (!brief) throw new NotFoundError();

  // A draft is promoted on the way out rather than requiring a separate
  // "submit" click first. Dispatching a brief *is* submitting it, and making
  // the operator perform both steps only creates a state where a brief is
  // submitted, undispatched, and waiting for nothing.
  if (brief.status !== "submitted" && brief.status !== "draft") {
    return {
      ok: false,
      reason: "wrong_status",
      message: `This brief is "${brief.status}" and cannot be sent again.`,
    };
  }
  if (!brief.connectionId || !brief.installationId || !brief.owner || !brief.name) {
    return {
      ok: false,
      reason: "no_repository",
      message:
        "This brief's site has no connected repository, so there is nothing to build in.",
    };
  }
  if (!brief.allowlisted) {
    return {
      ok: false,
      reason: "not_allowlisted",
      message: `${brief.owner}/${brief.name} is not allowlisted for automation.`,
    };
  }

  const scope = `${brief.owner}/${brief.name}`;
  const quota = await claimDispatchSlot(db, scope);
  if (!quota.granted) {
    return {
      ok: false,
      reason: "quota_exhausted",
      message: `Daily automation limit reached for this repository (${quota.count}/${quota.cap}).`,
    };
  }

  const agentJobPublicId = newPublicId();
  const timeoutMinutes = Number(process.env.AGENT_JOB_TIMEOUT_MINUTES ?? 30);

  const inserted = await db
    .insert(agentJobs)
    .values({
      publicId: agentJobPublicId,
      briefId: brief.id,
      repositoryConnectionId: brief.connectionId,
      baseRef: brief.defaultBranch,
      status: "queued",
      timeoutAt: new Date(Date.now() + timeoutMinutes * 60_000),
    })
    .returning({ id: agentJobs.id });

  const agentJobId = inserted[0]!.id;

  // Recorded for the operator, never acted on. Same rule as client text: a
  // brief is a transcription of what a third party said, so instruction-shaped
  // phrases in it are worth flagging even though the operator typed them.
  const findings = scanForInjection(
    [brief.colourDirection, brief.features, brief.contentNotes, brief.body]
      .filter(Boolean)
      .join("\n"),
  );

  const target: Repo = {
    installationId: brief.installationId,
    owner: brief.owner,
    name: brief.name,
  };

  let issue: { number: number; html_url: string };
  try {
    issue = await createIssue(target, {
      title: renderBriefIssueTitle(
        brief.publicId,
        brief.kind,
        brief.businessName,
      ),
      body: renderBriefIssueBody({
        briefPublicId: brief.publicId,
        agentJobPublicId,
        kind: brief.kind,
        colourDirection: brief.colourDirection,
        features: brief.features,
        contentNotes: brief.contentNotes,
        body: brief.body,
        businessName: brief.businessName,
        verifiedFacts: context.verifiedFacts,
        sourceWebsiteUrl: context.sourceWebsiteUrl,
      }),
      labels: ["portal-brief", "claude"],
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

    // No workflow ran, so no Actions minutes were spent. Charging the day's
    // budget for a failed API call would let one broken repository exhaust it.
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
    .set({ issueNumber: issue.number, status: "dispatched", dispatchedAt: now })
    .where(eq(agentJobs.id, agentJobId));

  await db
    .update(siteBriefs)
    .set({
      status: "dispatched",
      dispatchedAt: now,
      // Backfilled for a brief that went straight from draft to dispatched.
      // The schema refuses any non-draft status without this, and leaving it
      // null would mean "dispatched but never submitted", which is not a thing.
      submittedAt: brief.status === "draft" ? now : undefined,
      updatedAt: now,
    })
    .where(eq(siteBriefs.id, brief.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: brief.organizationId,
    action: "brief.dispatched",
    entityType: "site_brief",
    entityId: brief.publicId,
    metadata: {
      agentJobPublicId,
      repository: scope,
      issueNumber: issue.number,
      ...(findings.length ? { injectionFindings: findings } : {}),
    },
  });

  return {
    ok: true,
    agentJobPublicId,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
  };
}

/** Briefs for one client, newest first. */
export async function listBriefs(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
) {
  return db
    .select({
      publicId: siteBriefs.publicId,
      kind: siteBriefs.kind,
      status: siteBriefs.status,
      colourDirection: siteBriefs.colourDirection,
      features: siteBriefs.features,
      contentNotes: siteBriefs.contentNotes,
      body: siteBriefs.body,
      createdAt: siteBriefs.createdAt,
      dispatchedAt: siteBriefs.dispatchedAt,
    })
    .from(siteBriefs)
    .where(eq(siteBriefs.organizationId, organizationId))
    .orderBy(desc(siteBriefs.createdAt))
    .limit(20);
}

/** Resolve a client's organization id from its public id. */
export async function organizationForClient(
  db: Database,
  clientPublicId: string,
): Promise<string> {
  const rows = await db
    .select({ organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row.organizationId;
}
