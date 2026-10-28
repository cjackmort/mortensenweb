import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import { connectedAccounts } from "@/db/schema";
import { runAudit } from "../client/connections";

/**
 * The scheduled look at every connected account: once a day each, a few
 * per tick, so the monthly report on the 1st always has a recent audit to
 * repeat and a client opening Connections sees figures from today.
 */

export const AUDIT_EVERY_MS = 24 * 60 * 60 * 1000;
/** Per tick. Each is several provider calls; the tick has other work. */
const BATCH = 5;

export interface ScheduledAuditResult {
  audited: number;
  failed: number;
  skipped: number;
}

export async function runScheduledConnectionAudits(
  db: Database,
  { now = new Date() }: { now?: Date } = {},
): Promise<ScheduledAuditResult> {
  const due = await db
    .select({ organizationId: connectedAccounts.organizationId, provider: connectedAccounts.provider })
    .from(connectedAccounts)
    .where(
      and(
        isNull(connectedAccounts.revokedAt),
        eq(connectedAccounts.status, "connected"),
        or(isNull(connectedAccounts.lastAuditAt), lt(connectedAccounts.lastAuditAt, new Date(now.getTime() - AUDIT_EVERY_MS))),
      ),
    )
    .limit(BATCH);

  const result: ScheduledAuditResult = { audited: 0, failed: 0, skipped: 0 };
  for (const account of due) {
    const run = await runAudit(db, account.organizationId, account.provider, { now });
    if (run.ok) result.audited += 1;
    else if (run.reason === "not_connected") result.skipped += 1;
    else result.failed += 1;
  }
  return result;
}
