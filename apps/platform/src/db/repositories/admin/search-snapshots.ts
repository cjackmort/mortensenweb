import { and, eq, gt, isNull, notExists, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { connectedAccounts, searchSnapshots } from "@/db/schema";
import { dayOf, RETRY_AFTER_MS, takeSearchSnapshot, type SnapshotFetcher } from "../client/search-snapshots";

/**
 * The scheduled snapshot: every client with a live Google connection, once
 * a day, a few per tick. A day that failed is tried again after six hours,
 * so an outage at Google costs one morning, not the day.
 */

/** Per tick. Each is five Search Console calls; the tick has other work. */
const BATCH = 5;

export interface ScheduledSnapshotResult {
  taken: number;
  failed: number;
  skipped: number;
}

export async function runScheduledSearchSnapshots(
  db: Database,
  deps: { now?: Date; fetchSnapshot?: SnapshotFetcher } = {},
): Promise<ScheduledSnapshotResult> {
  const now = deps.now ?? new Date();
  const today = dayOf(now);
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);

  // Today's row for this client, unless it failed long enough ago to retry.
  const doneToday = db
    .select({ one: sql`1` })
    .from(searchSnapshots)
    .where(
      and(
        eq(searchSnapshots.organizationId, connectedAccounts.organizationId),
        eq(searchSnapshots.takenOn, today),
        or(isNull(searchSnapshots.error), gt(searchSnapshots.attemptedAt, retryBefore)),
      ),
    );

  const due = await db
    .select({ organizationId: connectedAccounts.organizationId })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, "google"),
        isNull(connectedAccounts.revokedAt),
        eq(connectedAccounts.status, "connected"),
        notExists(doneToday),
      ),
    )
    .limit(BATCH);

  const result: ScheduledSnapshotResult = { taken: 0, failed: 0, skipped: 0 };
  for (const { organizationId } of due) {
    const run = await takeSearchSnapshot(db, organizationId, { now, fetchSnapshot: deps.fetchSnapshot });
    if (run.ok) result.taken += 1;
    else if (run.reason === "not_connected" || run.reason === "no_site") result.skipped += 1;
    else result.failed += 1;
  }
  return result;
}
