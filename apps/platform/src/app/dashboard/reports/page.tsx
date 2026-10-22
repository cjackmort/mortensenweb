import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  getMyReportEmails,
  hasMonthlyReport,
  listMyReports,
} from "@/db/repositories/client/reports";
import { currentReportPeriod, nextPeriod, reportWindow } from "@/lib/reports/period";
import { formatDateWithYear } from "@/lib/time";
import { ReportEmailSwitch } from "./email-switch";

/**
 * Every monthly report a client has had, newest first, and the switch for
 * the email that announces them.
 *
 * A client whose plan does not include reports keeps any they already have:
 * a report is a record of a month that happened, not a feature to take away.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reports",
  robots: { index: false, follow: false },
};

export default async function ReportsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const [reports, eligible, emails] = await Promise.all([
    listMyReports(db, ctx),
    hasMonthlyReport(db, ctx),
    getMyReportEmails(db, ctx),
  ]);

  const thisMonth = currentReportPeriod();
  const firstReportOn = formatDateWithYear(reportWindow(nextPeriod(thisMonth)).startAt);

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Reports</h1>
        <span>What your website did each month</span>
      </div>

      {!eligible && reports.length === 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Monthly reports come with Care</h2>
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0 }}>
              On the 1st of each month: your visitors and the trend, taps on your phone number, enquiries
              from your contact form, and the changes we made. One page, and a short email.
            </p>
            <Link className="button" href="/dashboard/plan">
              See plans
            </Link>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>Your reports</h2>
          </div>
          {reports.length === 0 ? (
            <div className="empty">
              <p>
                Your first report arrives on {firstReportOn}, covering {reportWindow(thisMonth).label}.
              </p>
            </div>
          ) : (
            <ul className="lead-list">
              {reports.map((report) => (
                <li key={report.period}>
                  <Link className="lead-row" href={`/dashboard/reports/${report.period}`}>
                    <span className="lead-row-head">
                      <span className="lead-row-name">{report.label}</span>
                    </span>
                    <span className="lead-row-preview">
                      {report.headline ?? "This report can't be shown. Please let us know."}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(eligible || reports.length > 0) && (
        <section className="panel" id="emails">
          <div className="panel-head">
            <h2>Monthly email</h2>
          </div>
          <div className="panel-body">
            <ReportEmailSwitch on={emails.on} />
          </div>
        </section>
      )}
    </main>
  );
}
