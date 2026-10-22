import Link from "next/link";
import type { ClientReportsView } from "@/db/repositories/admin/reports";
import { formatDateTime } from "@/lib/time";
import { ReportButton } from "./report-forms";

const EMAIL_STATUS: Record<string, string> = {
  sent: "Emailed",
  skipped: "Not emailed (no mail key on this server)",
  failed: "Email failed",
  opted_out: "Not emailed (they opted out)",
  no_recipient: "Not emailed (no one to send to)",
};

/** What happened to a report's email, in plain words. */
export function emailStatusLabel(status: string | null): string {
  return status ? (EMAIL_STATUS[status] ?? status) : "Not emailed";
}

/**
 * Monthly reports for one client: what was built, what each email did, and
 * the buttons to preview, rebuild and re-send. Building here never emails;
 * the operator previews first and sends on purpose.
 */
export function ReportsSection({
  clientPublicId,
  view,
}: {
  clientPublicId: string;
  view: ClientReportsView;
}) {
  const { lastCompleted } = view;

  return (
    <section className="card" id="reports">
      <div className="card-head">
        <h2>Monthly reports</h2>
      </div>
      {view.paused ? (
        <p className="notice" style={{ marginTop: 0 }}>
          <strong>Paused: no report this month.</strong> Our work on them is paused, so the run on the 1st
          skips them. You can still build one by hand; it is not emailed until you send it.
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          {view.eligible
            ? `Built on the 1st of each month for ${view.planName ?? "their plan"}, and emailed to their portal users.`
            : "Not on their plan (Care and above). You can still build one by hand; it is not emailed until you send it."}
        </p>
      )}

      {!lastCompleted.built && (
        <div className="action-block">
          <ReportButton
            clientPublicId={clientPublicId}
            period={lastCompleted.period}
            intent="rebuild"
            label={`Build ${lastCompleted.label} now`}
          />
        </div>
      )}

      {view.reports.length === 0 ? (
        <p className="muted">No reports yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Month</th>
                <th>Headline</th>
                <th>Email</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.reports.map((report) => (
                <tr key={report.period}>
                  <td data-label="Month">
                    <Link href={`/admin/clients/${clientPublicId}/reports/${report.period}`}>{report.label}</Link>
                  </td>
                  <td data-label="Headline">{report.headline ?? "Unreadable: rebuild it"}</td>
                  <td data-label="Email">
                    {emailStatusLabel(report.emailStatus)}
                    {report.emailedAt && <span className="muted"> · {formatDateTime(report.emailedAt)}</span>}
                    {report.emailError && <span className="error"> · {report.emailError}</span>}
                  </td>
                  <td data-label="">
                    <Link href={`/admin/clients/${clientPublicId}/reports/${report.period}`}>Preview</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="action-block">
        <p style={{ marginTop: 0 }}>
          {view.emailsOff
            ? `Monthly emails are off (since ${formatDateTime(view.emailsOff.at)}${view.emailsOff.by ? `, by ${view.emailsOff.by}` : ""}).`
            : "Monthly emails are on."}
        </p>
        <ReportButton
          clientPublicId={clientPublicId}
          intent={view.emailsOff ? "emails-on" : "emails-off"}
          label={view.emailsOff ? "Turn emails back on" : "Turn emails off"}
          secondary
          confirm={view.emailsOff ? "Only do this if they asked for the emails back. Turn them on?" : undefined}
        />
      </div>
    </section>
  );
}
