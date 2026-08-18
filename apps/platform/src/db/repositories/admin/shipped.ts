import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  repositoryConnections,
  requestEvents,
  sites,
} from "@/db/schema";
import { findDeployForCommit, verifyUrlServes } from "@/lib/netlify/api";

/**
 * Following a merged change to the point it is actually on the website.
 *
 * The webhook takes a request as far as `merged` — the commit is on the default
 * branch — and nothing took it further. `deployed` and `verified` existed in the
 * enum and in the progress track with no code path that reached them, so every
 * change a client ever made came to rest reading "Not on your site yet" while a
 * timeline event directly above it said the change was live. The portal
 * contradicted itself on the same screen, and the contradiction always resolved
 * in the direction that made us look broken.
 *
 * Two steps, deliberately not collapsed into one:
 *
 *  - **merged → deployed** when Netlify reports a *ready* deploy for that exact
 *    merge commit. Matching on the commit rather than the branch is the same
 *    discipline `findDeployForCommit` was written for: a branch match would
 *    happily accept a later deploy of something else.
 *  - **deployed → verified** when the production URL is fetched and answers.
 *
 * Collapsing them would mean declaring a change live on the strength of a build
 * record, which is exactly the failure the rest of this codebase refuses to
 * make: a deploy that reports success while serving stale bytes is the common
 * silent failure, and the only thing that catches it is asking the URL.
 */

export interface ShipProgress {
  markedDeployed: string[];
  markedVerified: string[];
  /** Merged changes still waiting on a deploy. Not an error — builds take time. */
  awaitingDeploy: number;
}

export async function advanceShippedChanges(
  db: Database,
  { limit = 50 }: { limit?: number } = {},
): Promise<ShipProgress> {
  const rows = await db
    .select({
      requestId: changeRequests.id,
      requestPublicId: changeRequests.publicId,
      status: changeRequests.status,
      mergeCommitSha: agentJobs.mergeCommitSha,
      netlifySiteId: sites.netlifySiteId,
      productionUrl: sites.productionUrl,
      siteId: sites.id,
    })
    .from(changeRequests)
    .innerJoin(agentJobs, eq(agentJobs.requestId, changeRequests.id))
    .leftJoin(
      repositoryConnections,
      eq(repositoryConnections.id, agentJobs.repositoryConnectionId),
    )
    .leftJoin(sites, eq(sites.id, repositoryConnections.siteId))
    .where(
      and(
        inArray(changeRequests.status, ["merged", "deployed"]),
        isNotNull(agentJobs.mergeCommitSha),
      ),
    )
    .limit(limit);

  const markedDeployed: string[] = [];
  const markedVerified: string[] = [];
  let awaitingDeploy = 0;

  for (const row of rows) {
    // Each request is isolated: one unreachable site must not stop the rest of
    // the batch, the same way the cron runner isolates its four jobs.
    try {
      if (row.status === "merged") {
        if (!row.netlifySiteId || !row.mergeCommitSha) {
          awaitingDeploy += 1;
          continue;
        }

        const deploy = await findDeployForCommit(
          row.netlifySiteId,
          row.mergeCommitSha,
        );

        // "ready" is Netlify's terminal success state. Anything else — building,
        // enqueued, error — is not a deploy that has happened.
        if (!deploy || deploy.state !== "ready") {
          awaitingDeploy += 1;
          continue;
        }

        await db
          .update(changeRequests)
          .set({ status: "deployed", updatedAt: new Date() })
          .where(eq(changeRequests.id, row.requestId));

        // Internal: the client already has "your change is live" from the merge
        // webhook, and a second, more hedged message about the same event would
        // read as something having gone wrong.
        await db.insert(requestEvents).values({
          requestId: row.requestId,
          actorType: "system",
          kind: "change_deployed",
          body: `Netlify deploy ${deploy.id} for ${row.mergeCommitSha.slice(0, 8)} is ready.`,
          visibility: "internal",
        });

        markedDeployed.push(row.requestPublicId);
        continue;
      }

      // status === "deployed": ask the website itself.
      if (!row.productionUrl) continue;

      const check = await verifyUrlServes(row.productionUrl, { timeoutMs: 10_000 });
      if (!check.ok) continue;

      await db
        .update(changeRequests)
        .set({ status: "verified", closedAt: new Date(), updatedAt: new Date() })
        .where(eq(changeRequests.id, row.requestId));

      if (row.siteId) {
        await db
          .update(sites)
          .set({ liveVerifiedAt: new Date() })
          .where(eq(sites.id, row.siteId));
      }

      await db.insert(requestEvents).values({
        requestId: row.requestId,
        actorType: "system",
        kind: "change_verified",
        body: "We've checked your website and the change is there.",
        visibility: "client_visible",
      });

      markedVerified.push(row.requestPublicId);
    } catch (error) {
      console.error("[shipped] could not advance a merged change", {
        requestPublicId: row.requestPublicId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return { markedDeployed, markedVerified, awaitingDeploy };
}
