import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLog,
  clients,
  monthlyReportPreferences,
  monthlyReports,
  organizationMemberships,
  users,
} from "@/db/schema";
import { buildMonthlyReportEmail } from "@/lib/email/monthly-report";
import { sendEmail } from "@/lib/email/mailer";
import { includesMonthlyReport } from "@/lib/reports/eligibility";
import type { ReportExtension } from "@/lib/reports/extensions";
import {
  businessDayOfMonth,
  CATCH_UP_DAYS,
  lastCompletedPeriod,
  reportWindow,
} from "@/lib/reports/period";
import { parseReportData } from "@/lib/reports/types";
import { keepSchedulerAwake } from "@/lib/scheduler/gate";
import { buildReportData, loadReportSubjects, saveReport, type ReportSubject } from "./report-builder";

/**
 * Sending monthly reports, and the scheduled job that builds them.
 *
 * Email is a separate step after the report is stored, never part of it: a
 * mail provider outage must not lose a report, and a report that exists can
 * be re-sent from admin. Each attempt's outcome is recorded on the report row
 * so the operator can see which clients did not get theirs.
 */

export type EmailOutcome =
  | { status: "sent"; to: number }
  | { status: "skipped" | "opted_out" | "no_recipient" | "already_sent" | "no_report" }
  | { status: "failed"; error: string };

function portalUrl(): string {
  return process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
}

export async function reportEmailsOff(db: Database, organizationId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: monthlyReportPreferences.emailsOffAt })
    .from(monthlyReportPreferences)
    .where(eq(monthlyReportPreferences.organizationId, organizationId))
    .limit(1);
  return row?.at ?? null;
}

/**
 * Who the email goes to: the client's active portal users, the people who can
 * open the link, with the primary contact as the fallback for a client whose
 * account has not been issued yet. The same rule as request notifications.
 */
export async function reportRecipients(
  db: Database,
  organizationId: string,
): Promise<{ email: string; name: string | null }[]> {
  const members = await db
    .select({ email: users.email, name: users.name })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(users.role, "client"),
        eq(users.status, "active"),
      ),
    );
  if (members.length > 0) return members;

  const [client] = await db
    .select({ email: clients.primaryContactEmail, name: clients.primaryContactName })
    .from(clients)
    .where(eq(clients.organizationId, organizationId))
    .limit(1);
  return client?.email ? [{ email: client.email, name: client.name }] : [];
}

async function record(
  db: Database,
  reportId: string,
  outcome: EmailOutcome,
  now: Date,
): Promise<void> {
  if (outcome.status === "already_sent" || outcome.status === "no_report") return;
  await db
    .update(monthlyReports)
    .set({
      emailStatus: outcome.status,
      emailError: outcome.status === "failed" ? outcome.error : null,
      ...(outcome.status === "sent" ? { emailedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(monthlyReports.id, reportId));
}

/**
 * Email one stored report to the client.
 *
 * `resend` is the operator's button: it sends again even if this report went
 * out already. Neither path overrides an opt-out — a client who turned the
 * email off is asked to turn it back on, not emailed anyway.
 */
export async function emailReport(
  db: Database,
  organizationId: string,
  period: string,
  { resend = false, now = new Date(), actorUserId = null }: { resend?: boolean; now?: Date; actorUserId?: string | null } = {},
): Promise<EmailOutcome> {
  const [row] = await db
    .select({ id: monthlyReports.id, data: monthlyReports.data, emailStatus: monthlyReports.emailStatus })
    .from(monthlyReports)
    .where(and(eq(monthlyReports.organizationId, organizationId), eq(monthlyReports.period, period)))
    .limit(1);
  const data = row ? parseReportData(row.data) : null;
  if (!row || !data) return { status: "no_report" };
  if (!resend && row.emailStatus !== null) return { status: "already_sent" };

  let outcome: EmailOutcome;
  const recipients = await reportRecipients(db, organizationId);
  if (await reportEmailsOff(db, organizationId)) {
    outcome = { status: "opted_out" };
  } else if (recipients.length === 0) {
    outcome = { status: "no_recipient" };
  } else {
    outcome = await sendToAll(recipients, data);
  }

  // A re-send blocked by an opt-out leaves the record of the original send.
  if (!(resend && outcome.status === "opted_out")) await record(db, row.id, outcome, now);

  await db.insert(auditLog).values({
    action: resend ? "report.resent" : "report.emailed",
    entityType: "monthly_report",
    entityId: row.id,
    actorUserId,
    organizationId,
    metadata: { period, status: outcome.status, ...(outcome.status === "sent" ? { to: outcome.to } : {}) },
  });

  return outcome;
}

async function sendToAll(
  recipients: { email: string; name: string | null }[],
  data: NonNullable<ReturnType<typeof parseReportData>>,
): Promise<EmailOutcome> {
  let sent = 0;
  let skipped = false;
  let lastError: string | null = null;

  for (const recipient of recipients) {
    const message = buildMonthlyReportEmail({ contactName: recipient.name, data, portalUrl: portalUrl() });
    const result = await sendEmail({ ...message, to: recipient.email });
    if (result.status === "sent") sent += 1;
    else if (result.status === "skipped") skipped = true;
    else lastError = result.error;
  }

  if (sent > 0) return { status: "sent", to: sent };
  // Development: written to the console, never recorded as sent.
  if (lastError) return { status: "failed", error: lastError };
  return skipped ? { status: "skipped" } : { status: "no_recipient" };
}

// ---------------------------------------------------------------------------
// The scheduled job
// ---------------------------------------------------------------------------

/** Reports per tick. Each is ~9 Umami calls; Umami Cloud allows 50 per 15s. */
const BATCH = 5;

export type ScheduledReportsResult =
  | { ran: false; reason: "not_due" | "none_due" }
  | { ran: true; period: string; built: number; emailed: number; failed: number; remaining: number };

/**
 * Whether a subject should get `period`'s report: on the plan, a client by
 * then, and our work on them not paused. A pause lifted later in the catch-up
 * week lets that month's report through on the next tick.
 */
export function dueReport(subject: ReportSubject, period: string): boolean {
  if (subject.isDemo) return false;
  if (subject.managementPaused) return false;
  if (!includesMonthlyReport(subject)) return false;
  const window = reportWindow(period);
  // A client who signed up on the 1st has no September to report on.
  if (subject.createdAt.getTime() >= window.endAt.getTime()) return false;
  if (!subject.comped && (!subject.subscriptionStartedOn || subject.subscriptionStartedOn > window.lastDay)) {
    return false;
  }
  return true;
}

/**
 * Build and send last month's reports, on the first days of the month.
 *
 * Runs on every scheduler tick but does nothing after day `CATCH_UP_DAYS`:
 * the first sweep on the 1st builds them, and a portal that was down on the
 * 1st still catches up that week. Never mid-month, when a "September report"
 * would arrive weeks late and look like a mistake.
 *
 * Bounded per tick, because a report is a dozen network calls and the cron
 * endpoint has a minute for every job. When more are waiting it holds the
 * scheduler awake so the next five-minute tick carries on, rather than the
 * rest waiting six hours for the next sweep.
 */
export async function runScheduledMonthlyReports(
  db: Database,
  { now = new Date(), batch = BATCH, extensions }: { now?: Date; batch?: number; extensions?: ReportExtension[] } = {},
): Promise<ScheduledReportsResult> {
  if (businessDayOfMonth(now) > CATCH_UP_DAYS) return { ran: false, reason: "not_due" };
  const period = lastCompletedPeriod(now);

  const existing = new Set(
    (
      await db
        .select({ organizationId: monthlyReports.organizationId })
        .from(monthlyReports)
        .where(eq(monthlyReports.period, period))
    ).map((row) => row.organizationId),
  );
  const due = (await loadReportSubjects(db)).filter(
    (subject) => !existing.has(subject.organizationId) && dueReport(subject, period),
  );
  if (due.length === 0) return { ran: false, reason: "none_due" };

  let built = 0;
  let emailed = 0;
  let failed = 0;
  let next = 0;

  // The batch counts reports built, not attempts, so a client whose build
  // keeps throwing cannot hold the place of the clients queued behind it.
  for (; next < due.length && built < batch; next += 1) {
    const subject = due[next]!;
    try {
      const data = await buildReportData(db, subject, period, { now, extensions });
      const { created } = await saveReport(db, subject.organizationId, data, { now });
      if (!created) continue; // An overlapping run got there first and sends it.
      built += 1;
      const outcome = await emailReport(db, subject.organizationId, period, { now });
      if (outcome.status === "sent") emailed += 1;
      if (outcome.status === "failed") failed += 1;
    } catch (error) {
      failed += 1;
      console.error("[reports] could not build a monthly report", {
        organizationId: subject.organizationId,
        period,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const remaining = due.length - next;
  if (remaining > 0) await keepSchedulerAwake("monthly reports");

  return { ran: true, period, built, emailed, failed, remaining };
}
