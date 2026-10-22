import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, monthlyReportPreferences, monthlyReports } from "@/db/schema";
import { includesMonthlyReport, isManagementPaused } from "@/lib/reports/eligibility";
import { isPeriod, reportWindow } from "@/lib/reports/period";
import { parseReportData, type MonthlyReportData } from "@/lib/reports/types";
import { headline } from "@/lib/reports/wording";
import { assertMutable, type TenantContext } from "../context";
import { getEntitlements } from "./entitlements";

/**
 * Monthly reports, from the client's side: their list, one report, and the
 * switch for the email.
 *
 * Every query filters on `ctx.organizationId`. The period in a URL selects a
 * month *within* that organization and nothing else; a period belonging to
 * another client's report is simply a month this client has no report for.
 */

export interface ReportListItem {
  period: string;
  label: string;
  /** Null when the stored report cannot be read by this version of the code. */
  headline: string | null;
  builtAt: Date;
}

export async function listMyReports(db: Database, ctx: TenantContext): Promise<ReportListItem[]> {
  const rows = await db
    .select({ period: monthlyReports.period, data: monthlyReports.data, builtAt: monthlyReports.builtAt })
    .from(monthlyReports)
    .where(eq(monthlyReports.organizationId, ctx.organizationId))
    .orderBy(desc(monthlyReports.period));

  return rows.map((row) => {
    const data = parseReportData(row.data);
    return {
      period: row.period,
      label: data?.label ?? reportWindow(row.period).label,
      headline: data ? headline(data) : null,
      builtAt: row.builtAt,
    };
  });
}

export type MyReport =
  | { found: false }
  | { found: true; period: string; builtAt: Date; data: MonthlyReportData | null };

export async function getMyReport(db: Database, ctx: TenantContext, period: string): Promise<MyReport> {
  if (!isPeriod(period)) return { found: false };
  const [row] = await db
    .select({ data: monthlyReports.data, builtAt: monthlyReports.builtAt })
    .from(monthlyReports)
    .where(and(eq(monthlyReports.organizationId, ctx.organizationId), eq(monthlyReports.period, period)))
    .limit(1);
  if (!row) return { found: false };
  return { found: true, period, builtAt: row.builtAt, data: parseReportData(row.data) };
}

/** Whether their plan includes the report. Past reports stay readable either way. */
export async function hasMonthlyReport(db: Database, ctx: TenantContext): Promise<boolean> {
  const entitlements = await getEntitlements(db, ctx);
  return includesMonthlyReport({ planKey: entitlements?.planKey ?? null, comped: entitlements?.comped ?? false });
}

/** Whether new reports are paused because our work on their site is. */
export async function isMyReportPaused(db: Database, ctx: TenantContext): Promise<boolean> {
  const [row] = await db
    .select({ managementState: clients.managementState, managementPausedAt: clients.managementPausedAt })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  return row ? isManagementPaused(row) : false;
}

export async function getMyReportEmails(db: Database, ctx: TenantContext): Promise<{ on: boolean }> {
  const [row] = await db
    .select({ offAt: monthlyReportPreferences.emailsOffAt })
    .from(monthlyReportPreferences)
    .where(eq(monthlyReportPreferences.organizationId, ctx.organizationId))
    .limit(1);
  return { on: !row?.offAt };
}

/** Turn the monthly email on or off for the whole organization. */
export async function setMyReportEmails(db: Database, ctx: TenantContext, on: boolean): Promise<void> {
  assertMutable(ctx);
  const now = new Date();
  const values = { emailsOffAt: on ? null : now, emailsOffBy: on ? null : ctx.userId, updatedAt: now };
  await db
    .insert(monthlyReportPreferences)
    .values({ organizationId: ctx.organizationId, ...values })
    .onConflictDoUpdate({ target: monthlyReportPreferences.organizationId, set: values });
  await db.insert(auditLog).values({
    action: on ? "report.emails_on" : "report.emails_off",
    entityType: "monthly_report_preferences",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata: { by: "client" },
  });
}
