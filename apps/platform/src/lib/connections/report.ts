import { and, isNull, eq } from "drizzle-orm";
import { connectedAccounts } from "@/db/schema";
import type { ReportExtension } from "@/lib/reports/extensions";
import { PROVIDERS, CONNECTION_PROVIDERS, type ConnectionProvider } from "./index";
import { parseAudit, type Finding } from "./types";

/**
 * Each connected account's last audit, as a section of the monthly report.
 *
 * Not gated by a Growth feature: an account is connected or it is not, and
 * a client who connected one gets the section. The figures are the stored
 * audit — the scheduled job keeps it under a day old — so building a report
 * never calls a provider.
 */

/** The findings as one sentence under the rows: what to fix first, then what to improve. */
export function findingsNote(findings: Finding[]): string | null {
  const fix = findings.filter((f) => f.severity === "fix").map((f) => f.title);
  const improve = findings.filter((f) => f.severity === "improve").map((f) => f.title);
  const good = findings.filter((f) => f.severity === "good").map((f) => f.title);
  const parts = [
    fix.length > 0 ? `To fix: ${fix.join("; ")}.` : null,
    improve.length > 0 ? `To improve: ${improve.join("; ")}.` : null,
    fix.length === 0 && improve.length === 0 && good.length > 0 ? `${good.join("; ")}.` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? `${parts.join(" ")} The details are under Connections in your portal.` : null;
}

function extensionFor(provider: ConnectionProvider): ReportExtension {
  const adapter = PROVIDERS[provider];
  return {
    key: `connected-${provider}`,
    title: adapter.name,
    async build({ db, organizationId }) {
      const [row] = await db
        .select({ status: connectedAccounts.status, lastAudit: connectedAccounts.lastAudit })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.organizationId, organizationId),
            eq(connectedAccounts.provider, provider),
            isNull(connectedAccounts.revokedAt),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (row.status === "needs_reconnect") {
        return {
          state: "missing",
          headline: null,
          rows: [],
          note: `The ${adapter.name} connection lapsed. Connect it again under Connections in your portal.`,
        };
      }
      const audit = parseAudit(row.lastAudit);
      if (!audit) {
        return {
          state: "missing",
          headline: null,
          rows: [],
          note: `${adapter.name} is connected but has not been looked at yet. It will be in next month's report.`,
        };
      }
      return { state: "ok", headline: audit.headline, rows: audit.rows, note: findingsNote(audit.findings) };
    },
  };
}

export const CONNECTION_REPORT_EXTENSIONS: ReportExtension[] = CONNECTION_PROVIDERS.map(extensionFor);
