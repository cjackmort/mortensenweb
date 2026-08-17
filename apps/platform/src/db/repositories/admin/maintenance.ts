import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { previewDeployments, prospectShares, prospects } from "@/db/schema";

/**
 * Housekeeping that runs on a schedule.
 *
 * These are the jobs whose absence nobody notices for months and then notices
 * badly: a concept mock-up of somebody's business still reachable a year after
 * they said no, a preview deployment for a pull request closed in March.
 */

/**
 * Mark expired share links and their prospects.
 *
 * The links are already dead — `resolveShareToken` filters on `expiresAt`, so
 * an expired token stops working the moment it expires, with no job needed.
 * What this does is move the *prospect* to `expired`, which is what the
 * operator's list is showing them. Without it, a prospect sits at "shared"
 * forever, implying a live link and a conversation still in flight.
 */
export async function expireStaleShares(db: Database): Promise<number> {
  const now = new Date();

  // Prospects still marked `shared` whose links have all expired or been
  // revoked. The NOT EXISTS is the whole condition: one live link is enough to
  // keep the prospect active, so this must not fire on the first link expiring
  // when a second was issued later.
  const expired = await db
    .update(prospects)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(prospects.status, "shared"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${prospectShares}
          WHERE ${prospectShares.prospectId} = ${prospects.id}
            AND ${prospectShares.revokedAt} IS NULL
            AND ${prospectShares.expiresAt} > ${now}
        )`,
        // Only prospects that had a link at all. A prospect at `shared` with no
        // share rows is a data inconsistency, not an expiry, and quietly
        // relabelling it would hide the bug.
        sql`EXISTS (
          SELECT 1 FROM ${prospectShares}
          WHERE ${prospectShares.prospectId} = ${prospects.id}
        )`,
      ),
    )
    .returning({ id: prospects.id });

  // Concept previews past their expiry are marked so, which is what the admin
  // UI reads. The deployment itself is left alone: deleting a Netlify site from
  // a scheduled job is the kind of automation that eventually deletes the wrong
  // one, and the cost of leaving it is a few megabytes on a free tier.
  await db
    .update(previewDeployments)
    .set({ status: "expired" })
    .where(
      and(
        eq(previewDeployments.kind, "concept"),
        lt(previewDeployments.expiresAt, now),
        // `ne` would also match rows already expired and rewrite them every run.
        sql`${previewDeployments.status} <> 'expired'`,
      ),
    );

  return expired.length;
}

/**
 * Previews for pull requests that are no longer open.
 *
 * Kept separate from concept expiry because the trigger is different — a pull
 * request closing, not a date passing — and because these are the URLs clients
 * were sent. A stale one that still resolves is a client looking at a change
 * they approved weeks ago and wondering why it is not on their real site.
 */
export async function markClosedPullRequestPreviews(
  db: Database,
): Promise<number> {
  const updated = await db
    .update(previewDeployments)
    .set({ status: "superseded" })
    .where(
      and(
        eq(previewDeployments.kind, "pull_request"),
        isNull(previewDeployments.expiresAt),
        sql`${previewDeployments.status} = 'ready'`,
        sql`EXISTS (
          SELECT 1 FROM agent_jobs
          WHERE agent_jobs.id = ${previewDeployments.agentJobId}
            AND agent_jobs.status IN ('merged', 'cancelled', 'failed', 'timed_out')
        )`,
      ),
    )
    .returning({ id: previewDeployments.id });

  return updated.length;
}
