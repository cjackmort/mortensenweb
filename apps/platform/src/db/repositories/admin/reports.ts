import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, clients, monthlyReportPreferences, monthlyReports, users } from "@/db/schema";
import { buildMonthlyReportEmail } from "@/lib/email/monthly-report";
import type { EmailMessage } from "@/lib/email/mailer";
import { includesMonthlyReport } from "@/lib/reports/eligibility";
import { isCompletedPeriod, isPeriod, lastCompletedPeriod, reportWindow } from "@/lib/reports/period";
import { parseReportData, type MonthlyReportData } from "@/lib/reports/types";
import { headline } from "@/lib/reports/wording";
import { NotFoundError, type AdminContext } from "../context";
import { buildReportData, loadReportSubjects, saveReport } from "./report-builder";
import { emailReport, reportRecipients, type EmailOutcome } from "./report-delivery";

/**
 * Monthly reports from the operator's side: every report a client has had,
 * what happened to each email, a preview of exactly what the client sees and
 * receives, and the buttons to rebuild, re-send, or switch the email off.
 */

export type ReportActionResult = { ok: true; message: string } | { ok: false; message: string };

async function organizationFor(db: Database, clientPublicId: string): Promise<string> {
  const [row] = await db
    .select({ organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row.organizationId;
}

export interface AdminReportRow {
  period: string;
  label: string;
  headline: string | null;
  builtAt: Date;
  emailStatus: string | null;
  emailedAt: Date | null;
  emailError: string | null;
}

export interface ClientReportsView {
  eligible: boolean;
  /** Our work on them is paused, so the scheduled run skips them. */
  paused: boolean;
  planName: string | null;
  emailsOff: { at: Date; by: string | null } | null;
  reports: AdminReportRow[];
  /** The month a report can be built for now, and whether it has been. */
  lastCompleted: { period: string; label: string; built: boolean };
}

export async function getClientReports(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  now: Date = new Date(),
): Promise<ClientReportsView> {
  const organizationId = await organizationFor(db, clientPublicId);
  const [subject] = await loadReportSubjects(db, { organizationId });

  const rows = await db
    .select({
      period: monthlyReports.period,
      data: monthlyReports.data,
      builtAt: monthlyReports.builtAt,
      emailStatus: monthlyReports.emailStatus,
      emailedAt: monthlyReports.emailedAt,
      emailError: monthlyReports.emailError,
    })
    .from(monthlyReports)
    .where(eq(monthlyReports.organizationId, organizationId))
    .orderBy(desc(monthlyReports.period));

  const [pref] = await db
    .select({ at: monthlyReportPreferences.emailsOffAt, by: users.email })
    .from(monthlyReportPreferences)
    .leftJoin(users, eq(users.id, monthlyReportPreferences.emailsOffBy))
    .where(eq(monthlyReportPreferences.organizationId, organizationId))
    .limit(1);

  const last = lastCompletedPeriod(now);
  return {
    eligible: subject ? includesMonthlyReport(subject) : false,
    paused: subject?.managementPaused ?? false,
    planName: subject?.planName ?? null,
    emailsOff: pref?.at ? { at: pref.at, by: pref.by } : null,
    reports: rows.map((row) => {
      const data = parseReportData(row.data);
      return {
        period: row.period,
        label: data?.label ?? reportWindow(row.period).label,
        headline: data ? headline(data) : null,
        builtAt: row.builtAt,
        emailStatus: row.emailStatus,
        emailedAt: row.emailedAt,
        emailError: row.emailError,
      };
    }),
    lastCompleted: {
      period: last,
      label: reportWindow(last).label,
      built: rows.some((row) => row.period === last),
    },
  };
}

export interface ReportPreview {
  data: MonthlyReportData | null;
  builtAt: Date;
  emailStatus: string | null;
  emailedAt: Date | null;
  emailError: string | null;
  recipients: string[];
  emailsOff: boolean;
  /** The email as the first recipient would get it. */
  email: EmailMessage | null;
}

export async function getClientReportPreview(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  period: string,
): Promise<ReportPreview | null> {
  if (!isPeriod(period)) return null;
  const organizationId = await organizationFor(db, clientPublicId);
  const [row] = await db
    .select({
      data: monthlyReports.data,
      builtAt: monthlyReports.builtAt,
      emailStatus: monthlyReports.emailStatus,
      emailedAt: monthlyReports.emailedAt,
      emailError: monthlyReports.emailError,
    })
    .from(monthlyReports)
    .where(and(eq(monthlyReports.organizationId, organizationId), eq(monthlyReports.period, period)))
    .limit(1);
  if (!row) return null;

  const data = parseReportData(row.data);
  const recipients = await reportRecipients(db, organizationId);
  const [pref] = await db
    .select({ at: monthlyReportPreferences.emailsOffAt })
    .from(monthlyReportPreferences)
    .where(eq(monthlyReportPreferences.organizationId, organizationId))
    .limit(1);

  return {
    data,
    builtAt: row.builtAt,
    emailStatus: row.emailStatus,
    emailedAt: row.emailedAt,
    emailError: row.emailError,
    recipients: recipients.map((r) => r.email),
    emailsOff: Boolean(pref?.at),
    email: data
      ? buildMonthlyReportEmail({
          contactName: recipients[0]?.name ?? null,
          data,
          portalUrl: process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "",
        })
      : null,
  };
}

/**
 * Build (or rebuild) a client's report for a finished month, without emailing.
 *
 * For a report built while analytics was down, or a client who joined after
 * the scheduled run. Works for any client, eligible or not, because it is the
 * operator's decision — but the Growth sections still follow their plan.
 */
export async function rebuildClientReport(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  period: string,
  now: Date = new Date(),
): Promise<ReportActionResult> {
  if (!isPeriod(period)) return { ok: false, message: "That is not a month." };
  if (!isCompletedPeriod(period, now)) {
    return { ok: false, message: "That month isn't over yet. A report covers a whole month." };
  }
  const organizationId = await organizationFor(db, clientPublicId);
  const [subject] = await loadReportSubjects(db, { organizationId });
  if (!subject) return { ok: false, message: "That client no longer exists." };

  const data = await buildReportData(db, subject, period, { now });
  const { created } = await saveReport(db, organizationId, data, { replace: true, now });
  await db.insert(auditLog).values({
    action: created ? "report.built" : "report.rebuilt",
    entityType: "monthly_report",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId,
    metadata: { period },
  });
  return {
    ok: true,
    message: `${data.label} ${created ? "built" : "rebuilt"}. Nothing was emailed — use Re-send when it looks right.`,
  };
}

const RESEND_MESSAGES: Record<EmailOutcome["status"], string> = {
  sent: "Sent.",
  skipped: "Not sent: this server has no mail key, so it was written to the log instead.",
  opted_out: "Not sent: they've turned these emails off. Turn them back on first if they asked for it.",
  no_recipient: "Not sent: they have no portal users and no contact email.",
  already_sent: "Already sent.",
  no_report: "There is no report for that month.",
  failed: "The email failed.",
};

export async function resendClientReport(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  period: string,
): Promise<ReportActionResult> {
  if (!isPeriod(period)) return { ok: false, message: "That is not a month." };
  const organizationId = await organizationFor(db, clientPublicId);
  const outcome = await emailReport(db, organizationId, period, { resend: true, actorUserId: ctx.userId });
  if (outcome.status === "sent") {
    return { ok: true, message: `Sent to ${outcome.to} ${outcome.to === 1 ? "person" : "people"}.` };
  }
  const message = outcome.status === "failed" ? `The email failed: ${outcome.error}` : RESEND_MESSAGES[outcome.status];
  return { ok: false, message };
}

/** The operator switching the email on or off on the client's behalf. */
export async function setClientReportEmails(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  on: boolean,
): Promise<ReportActionResult> {
  const organizationId = await organizationFor(db, clientPublicId);
  const now = new Date();
  const values = { emailsOffAt: on ? null : now, emailsOffBy: on ? null : ctx.userId, updatedAt: now };
  await db
    .insert(monthlyReportPreferences)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: monthlyReportPreferences.organizationId, set: values });
  await db.insert(auditLog).values({
    action: on ? "report.emails_on" : "report.emails_off",
    entityType: "monthly_report_preferences",
    entityId: null,
    actorUserId: ctx.userId,
    organizationId,
    metadata: { by: "operator" },
  });
  return { ok: true, message: on ? "Monthly emails are on." : "Monthly emails are off. Their reports still appear in the portal." };
}
