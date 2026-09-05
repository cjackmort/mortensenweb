import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  previewDeployments,
  repositoryConnections,
  requestEvents,
  siteBriefs,
  sites,
  webhookDeliveries,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { parseAgentJobMarker, parseEscalationMarker } from "@/lib/github/issue";
import { previewUrlFor, verifyUrlServes } from "@/lib/netlify/api";
import { notifyClientOfRequest } from "@/lib/notify/request";

/**
 * Processing a GitHub webhook.
 *
 * This is the return half of the automation pipeline — the half that was
 * missing. The portal opens an issue; Claude opens a pull request; **this** is
 * what notices, records the preview, and lets the client be shown something.
 *
 * Three properties this module is responsible for:
 *
 * **Idempotency.** GitHub retries deliveries and can deliver out of order. The
 * unique index on `(provider, delivery_id)` is the mechanism: a duplicate fails
 * to insert, and we acknowledge without reprocessing. Doing the same work twice
 * here would mean two preview rows and, at the wrong moment, two merges.
 *
 * **Identity by node id.** Repository *names* can be changed by anyone with
 * push access. Node ids cannot. Every correlation and every allowlist check
 * therefore goes through `repo_node_id`, so renaming a repository cannot smuggle
 * it into or out of the allowlist.
 *
 * **The marker, not the title.** A pull request is matched to a job by the
 * `<!-- agent-job:… -->` comment copied from the issue body. Matching on branch
 * names or titles would be guessing, and guessing wrong here attaches a client's
 * approval to somebody else's change.
 */

/** Events we act on. Everything else is acknowledged and dropped. */
export const HANDLED_EVENTS = new Set([
  "pull_request",
  "check_suite",
  "workflow_run",
  "ping",
]);

export type DeliveryOutcome =
  | { status: "processed"; note: string }
  | { status: "duplicate" }
  | { status: "ignored"; note: string }
  | { status: "rejected"; note: string };

/**
 * Record the delivery, or report that we have seen it before.
 *
 * The insert *is* the idempotency check. Reading first and then inserting would
 * leave a window in which two concurrent retries both read "not seen" — which
 * is exactly the case retries produce.
 */
async function claimDelivery(
  db: Database,
  input: {
    deliveryId: string;
    event: string | null;
    action: string | null;
    repoNodeId: string | null;
    signatureValid: boolean;
  },
): Promise<boolean> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      provider: "github",
      deliveryId: input.deliveryId,
      event: input.event,
      action: input.action,
      repoNodeId: input.repoNodeId,
      signatureValid: input.signatureValid,
      status: "received",
    })
    .onConflictDoNothing({
      target: [webhookDeliveries.provider, webhookDeliveries.deliveryId],
    })
    .returning({ id: webhookDeliveries.id });

  return inserted.length > 0;
}

async function markDeliveryProcessed(
  db: Database,
  deliveryId: string,
  status: string,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status, processedAt: new Date() })
    .where(
      and(
        eq(webhookDeliveries.provider, "github"),
        eq(webhookDeliveries.deliveryId, deliveryId),
      ),
    );
}

/**
 * The allowlisted repository behind a node id, or null.
 *
 * Returning null for "not allowlisted" as well as "unknown" is deliberate: from
 * the receiver's point of view they mean the same thing — do not act — and
 * distinguishing them in the return type invites a caller to treat one as
 * recoverable.
 */
async function allowlistedRepo(db: Database, repoNodeId: string) {
  const rows = await db
    .select({
      connectionId: repositoryConnections.id,
      owner: repositoryConnections.owner,
      name: repositoryConnections.name,
      installationId: repositoryConnections.installationId,
      defaultBranch: repositoryConnections.defaultBranch,
      siteId: repositoryConnections.siteId,
      netlifySiteName: sites.netlifySiteName,
      previewUrlStyle: sites.previewUrlStyle,
      organizationId: sites.organizationId,
    })
    .from(repositoryConnections)
    .leftJoin(sites, eq(sites.id, repositoryConnections.siteId))
    .where(
      and(
        eq(repositoryConnections.repoNodeId, repoNodeId),
        eq(repositoryConnections.allowlisted, true),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Pull request events
// ---------------------------------------------------------------------------

interface PullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    body?: string | null;
    html_url?: string;
    draft?: boolean;
    merged?: boolean;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
  };
  repository?: { node_id?: string };
}

/**
 * A pull request opened, updated, or closed on a client repository.
 *
 * The interesting transitions:
 *  - `opened` / `reopened`  → the agent produced something; record it, derive
 *                             the preview URL, and try to verify it
 *  - `synchronize`          → new commits; the previously approved SHA is stale,
 *                             so any client decision must be withdrawn
 *  - `closed` with merged   → the change shipped
 *  - `closed` without merge → the attempt was abandoned
 */
async function handlePullRequest(
  db: Database,
  payload: PullRequestPayload,
): Promise<DeliveryOutcome> {
  const pr = payload.pull_request;
  const nodeId = payload.repository?.node_id;
  if (!pr || !nodeId) {
    return { status: "ignored", note: "Payload had no pull request." };
  }

  const repo = await allowlistedRepo(db, nodeId);
  if (!repo) {
    return { status: "rejected", note: "Repository is not allowlisted." };
  }

  const markerId = parseAgentJobMarker(pr.body);
  if (!markerId) {
    // Expected and harmless: a human opening a pull request in a client repo,
    // or an agent that did not copy the marker. Neither is ours to act on.
    return { status: "ignored", note: "No agent-job marker in the body." };
  }

  const jobs = await db
    .select({
      id: agentJobs.id,
      requestId: agentJobs.requestId,
      briefId: agentJobs.briefId,
      status: agentJobs.status,
      clientDecision: agentJobs.clientDecision,
    })
    .from(agentJobs)
    .where(eq(agentJobs.publicId, markerId))
    .limit(1);

  const job = jobs[0];
  if (!job) {
    return { status: "ignored", note: "Marker did not match a known job." };
  }

  const headSha = pr.head?.sha ?? null;
  const action = payload.action ?? "";
  const now = new Date();

  // The agent asking for a person, before anything else is considered.
  //
  // Checked ahead of the action branches because an escalation is a statement
  // about the *request*, not about this pull request's lifecycle. The agent
  // opens one carrying the marker and whatever partial work it did; without
  // this the request would sit on "being worked on" until the watchdog failed
  // it half an hour later and told the client something went wrong. Nothing
  // went wrong — the agent made exactly the call we want it to make.
  //
  // A pull request that escalates is never merged automatically: the merge
  // guard still applies, and `needs_operator` is not a state Apply acts on.
  const escalation = parseEscalationMarker(pr.body);
  if (escalation.escalated && job.requestId) {
    await db
      .update(changeRequests)
      .set({ status: "needs_operator", updatedAt: now })
      .where(eq(changeRequests.id, job.requestId));

    await db.insert(requestEvents).values([
      {
        requestId: job.requestId,
        actorType: "agent",
        kind: "escalated",
        // Operator-facing: the agent's own words about what stopped it, which
        // is the thing that decides how the handoff session should start.
        body: escalation.reason ?? "The agent asked for a person, without a reason.",
        visibility: "internal",
        metadata: { prNumber: pr.number ?? null },
      },
      {
        requestId: job.requestId,
        actorType: "system",
        kind: "escalated_notice",
        body: "One of us is handling this one personally. We'll be in touch.",
        visibility: "client_visible",
      },
    ]);

    await notifyClientOfRequest(db, job.requestId, "person_handling");

    return { status: "processed", note: "Escalated to the operator." };
  }

  if (action === "closed") {
    const merged = Boolean(pr.merged);
    await db
      .update(agentJobs)
      .set({
        status: merged ? "merged" : "cancelled",
        ...(merged ? { mergedAt: now } : {}),
        finishedAt: now,
      })
      .where(eq(agentJobs.id, job.id));

    if (job.requestId) {
      await db
        .update(changeRequests)
        .set({ status: merged ? "merged" : "closed", updatedAt: now })
        .where(eq(changeRequests.id, job.requestId));

      await db.insert(requestEvents).values({
        requestId: job.requestId,
        actorType: "system",
        kind: merged ? "change_applied" : "change_abandoned",
        body: merged
          ? "Your change is live on your website."
          : "We closed this change without applying it.",
        visibility: "client_visible",
      });
    }

    if (job.briefId && merged) {
      await db
        .update(siteBriefs)
        .set({ status: "applied", updatedAt: now })
        .where(eq(siteBriefs.id, job.briefId));
    }

    return { status: "processed", note: merged ? "Merged." : "Closed." };
  }

  if (action === "synchronize") {
    // New commits landed. Whatever the client approved, they did not approve
    // this — so the decision is withdrawn rather than carried forward onto code
    // they have not seen. The check constraint requires the timestamp to be
    // cleared alongside it.
    await db
      .update(agentJobs)
      .set({
        headSha,
        clientDecision: "pending",
        clientDecisionAt: null,
        clientDecisionByUserId: null,
        previewVerifiedAt: null,
      })
      .where(eq(agentJobs.id, job.id));

    if (job.requestId && job.clientDecision === "approved") {
      await db.insert(requestEvents).values({
        requestId: job.requestId,
        actorType: "system",
        kind: "preview_updated",
        body: "We've made further changes, so please take another look before this goes live.",
        visibility: "client_visible",
      });
    }

    return { status: "processed", note: "Head moved; approval withdrawn." };
  }

  if (action !== "opened" && action !== "reopened" && action !== "ready_for_review") {
    return { status: "ignored", note: `Unhandled action: ${action}.` };
  }

  // A preview URL can be *derived* the moment the pull request exists, but it
  // does not resolve until the deploy finishes. It is stored now and shown only
  // once verified — see the `previewVerifiedAt` gate below.
  const previewUrl = repo.netlifySiteName
    ? previewUrlFor(repo.netlifySiteName, pr.number, repo.previewUrlStyle ?? "pr_alias")
    : null;

  await db
    .update(agentJobs)
    .set({
      status: "pr_open",
      prNumber: pr.number,
      prUrl: pr.html_url ?? null,
      headSha,
      previewUrl,
      // Explicitly not verified yet. The build has almost certainly not run.
      previewVerifiedAt: null,
    })
    .where(eq(agentJobs.id, job.id));

  if (previewUrl) {
    await db.insert(previewDeployments).values({
      publicId: newPublicId(),
      agentJobId: job.id,
      siteId: repo.siteId,
      prNumber: pr.number,
      kind: "pull_request",
      url: previewUrl,
      status: "building",
    });
  }

  if (job.requestId) {
    await db
      .update(changeRequests)
      .set({ status: "pr_open", updatedAt: now })
      .where(eq(changeRequests.id, job.requestId));

    // The agent's own account of what it changed, written for the client
    // (the workflow prompt asks for exactly that after the marker line). It
    // was always in the pull request; now it reaches the person approving
    // the change, on the request's timeline and in the preview panel.
    const summary = clientSummaryFromPullRequest(pr.body);

    await db.insert(requestEvents).values([
      {
        requestId: job.requestId,
        actorType: "agent",
        kind: "change_drafted",
        body: "We've made the change and we're building a preview for you.",
        visibility: "client_visible",
      },
      ...(summary
        ? [
            {
              requestId: job.requestId,
              actorType: "agent" as const,
              kind: "agent_summary",
              body: summary,
              visibility: "client_visible" as const,
              metadata: { prNumber: pr.number },
            },
          ]
        : []),
      {
        requestId: job.requestId,
        actorType: "system",
        kind: "pr_opened",
        body: `Pull request #${pr.number} opened in ${repo.owner}/${repo.name}.`,
        visibility: "internal",
        metadata: { prNumber: pr.number, headSha, previewUrl },
      },
    ]);
  }

  return { status: "processed", note: `Pull request #${pr.number} recorded.` };
}

// ---------------------------------------------------------------------------
// Build completion
// ---------------------------------------------------------------------------

interface CheckSuitePayload {
  action?: string;
  check_suite?: { head_sha?: string; conclusion?: string | null };
  workflow_run?: { head_sha?: string; conclusion?: string | null };
  repository?: { node_id?: string };
}

/**
 * A build finished. If it was the deploy for a pull request we are tracking,
 * this is the moment the preview becomes real.
 *
 * The verification is what makes the client-facing link trustworthy: the URL
 * was derived when the pull request opened, and only a successful fetch against
 * it moves `previewVerifiedAt`. A client is never sent to a page that did not
 * answer.
 */
async function handleBuildCompletion(
  db: Database,
  payload: CheckSuitePayload,
): Promise<DeliveryOutcome> {
  const nodeId = payload.repository?.node_id;
  const headSha =
    payload.check_suite?.head_sha ?? payload.workflow_run?.head_sha ?? null;
  const conclusion =
    payload.check_suite?.conclusion ?? payload.workflow_run?.conclusion ?? null;

  if (!nodeId || !headSha) {
    return { status: "ignored", note: "No repository or head SHA." };
  }
  if (payload.action !== "completed") {
    return { status: "ignored", note: "Build not finished." };
  }

  const repo = await allowlistedRepo(db, nodeId);
  if (!repo) return { status: "rejected", note: "Repository is not allowlisted." };

  const jobs = await db
    .select({
      id: agentJobs.id,
      requestId: agentJobs.requestId,
      previewUrl: agentJobs.previewUrl,
      previewVerifiedAt: agentJobs.previewVerifiedAt,
    })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.repositoryConnectionId, repo.connectionId),
        eq(agentJobs.headSha, headSha),
      ),
    )
    .limit(1);

  const job = jobs[0];
  if (!job) return { status: "ignored", note: "No job for this commit." };

  if (conclusion !== "success") {
    if (job.requestId) {
      await db.insert(requestEvents).values({
        requestId: job.requestId,
        actorType: "system",
        kind: "preview_build_failed",
        // Internal only. "Your build failed" tells a client nothing they can
        // act on and reads as though their request broke something.
        body: `Preview build concluded "${conclusion ?? "unknown"}".`,
        visibility: "internal",
      });
    }
    return { status: "processed", note: "Build failed; nothing shown." };
  }

  if (!job.previewUrl) {
    return { status: "processed", note: "No preview URL to verify." };
  }
  if (job.previewVerifiedAt) {
    return { status: "processed", note: "Preview already verified." };
  }

  const check = await verifyUrlServes(job.previewUrl);
  if (!check.ok) {
    // The build says it succeeded and the URL does not answer. Do not show it.
    // Netlify's DNS for a new alias can lag the deploy by a few seconds, so the
    // watchdog re-checks rather than this failing permanently.
    await db.insert(previewDeployments).values({
      publicId: newPublicId(),
      agentJobId: job.id,
      siteId: repo.siteId,
      kind: "pull_request",
      url: job.previewUrl,
      status: `unverified:${check.reason}`,
    });
    return { status: "processed", note: `Preview did not answer (${check.reason}).` };
  }

  const now = new Date();
  await db
    .update(agentJobs)
    .set({ previewVerifiedAt: now })
    .where(eq(agentJobs.id, job.id));

  await db
    .update(previewDeployments)
    .set({ status: "ready", verifiedAt: now })
    .where(
      and(
        eq(previewDeployments.agentJobId, job.id),
        eq(previewDeployments.url, job.previewUrl),
      ),
    );

  if (job.requestId) {
    await db.insert(requestEvents).values({
      requestId: job.requestId,
      actorType: "system",
      kind: "preview_ready",
      body: "Your preview is ready to look at.",
      visibility: "client_visible",
      metadata: { previewUrl: job.previewUrl },
    });
    // The email is what turns a verified preview into an approved one. Sent
    // after the event is recorded, and idempotent, so the scheduled re-check
    // that can verify the same preview a minute later sends nothing twice.
    await notifyClientOfRequest(db, job.requestId, "preview_ready");
  }

  return { status: "processed", note: "Preview verified." };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface DeliveryInput {
  deliveryId: string;
  event: string;
  /** Already parsed by the route, which verified the signature over raw bytes. */
  payload: unknown;
  signatureValid: boolean;
}

/**
 * Process one verified delivery.
 *
 * The signature is checked by the caller, over the raw body, before this is
 * reached — but `signatureValid` is recorded here anyway, and an invalid
 * delivery is stored and refused rather than silently dropped. A run of
 * signature failures is something an operator needs to be able to see.
 */
export async function processGithubDelivery(
  db: Database,
  input: DeliveryInput,
): Promise<DeliveryOutcome> {
  const payload = (input.payload ?? {}) as {
    action?: string;
    repository?: { node_id?: string };
  };

  const claimed = await claimDelivery(db, {
    deliveryId: input.deliveryId,
    event: input.event,
    action: payload.action ?? null,
    repoNodeId: payload.repository?.node_id ?? null,
    signatureValid: input.signatureValid,
  });

  if (!claimed) return { status: "duplicate" };

  if (!input.signatureValid) {
    await markDeliveryProcessed(db, input.deliveryId, "rejected_signature");
    return { status: "rejected", note: "Signature did not verify." };
  }

  if (!HANDLED_EVENTS.has(input.event)) {
    await markDeliveryProcessed(db, input.deliveryId, "ignored");
    return { status: "ignored", note: `Unhandled event: ${input.event}.` };
  }

  let outcome: DeliveryOutcome;
  try {
    switch (input.event) {
      case "ping":
        outcome = { status: "processed", note: "Ping acknowledged." };
        break;
      case "pull_request":
        outcome = await handlePullRequest(db, input.payload as never);
        break;
      case "check_suite":
      case "workflow_run":
        outcome = await handleBuildCompletion(db, input.payload as never);
        break;
      default:
        outcome = { status: "ignored", note: "Unhandled event." };
    }
  } catch (error) {
    // The delivery row stays, marked failed, so a processing bug is visible
    // rather than looking like an event GitHub never sent.
    await markDeliveryProcessed(db, input.deliveryId, "failed");
    throw error;
  }

  await markDeliveryProcessed(db, input.deliveryId, outcome.status);
  return outcome;
}

/**
 * Re-check previews that built successfully but did not answer in time.
 *
 * Netlify publishes an alias a moment after the deploy reports success, so a
 * verification attempted immediately can legitimately miss. Rather than showing
 * an unverified link or giving up, this runs on the schedule and catches up.
 */
export async function reverifyPendingPreviews(db: Database): Promise<number> {
  const pending = await db
    .select({
      id: agentJobs.id,
      requestId: agentJobs.requestId,
      previewUrl: agentJobs.previewUrl,
    })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.status, "pr_open"),
        sql`${agentJobs.previewUrl} IS NOT NULL`,
        sql`${agentJobs.previewVerifiedAt} IS NULL`,
      ),
    )
    .limit(25);

  let verified = 0;

  for (const job of pending) {
    if (!job.previewUrl) continue;
    const check = await verifyUrlServes(job.previewUrl);
    if (!check.ok) continue;

    const now = new Date();
    await db
      .update(agentJobs)
      .set({ previewVerifiedAt: now })
      .where(eq(agentJobs.id, job.id));

    await db
      .update(previewDeployments)
      .set({ status: "ready", verifiedAt: now })
      .where(eq(previewDeployments.agentJobId, job.id));

    if (job.requestId) {
      await db.insert(requestEvents).values({
        requestId: job.requestId,
        actorType: "system",
        kind: "preview_ready",
        body: "Your preview is ready to look at.",
        visibility: "client_visible",
        metadata: { previewUrl: job.previewUrl },
      });
      await notifyClientOfRequest(db, job.requestId, "preview_ready");
    }

    verified += 1;
  }

  return verified;
}


/**
 * The part of a pull request description meant for the client.
 *
 * Everything the portal needs from the body — the job marker, an escalation
 * marker — is an HTML comment, and everything after those is the agent's
 * write-up "for a non-technical reader". Comments are stripped, markdown
 * headings are flattened to plain lines, and the result is capped so a
 * verbose run cannot push the approval buttons off a phone screen. Empty
 * when the agent wrote nothing beyond the marker, so the timeline shows no
 * blank entry.
 */
export function clientSummaryFromPullRequest(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return text.length > 1500 ? `${text.slice(0, 1497).trimEnd()}…` : text;
}
