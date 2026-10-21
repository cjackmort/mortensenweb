import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { listWinbackCampaigns } from "@/db/repositories/admin/winback";
import { formatDateTime, formatDateWithYear } from "@/lib/time";
import { CampaignStatusPill } from "@/app/dashboard/growth/winback/parts";
import { HaltAllForm, HaltCampaignForm } from "./forms";
import "@/app/dashboard/growth/winback/winback.css";

/**
 * Every client's approved win-back emails, newest first, with a stop button
 * on anything scheduled or sending and one that stops them all.
 *
 * Drafts are not listed: until a client approves one it is their own
 * business, and nothing about it can reach a customer.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Win-back emails",
  robots: { index: false, follow: false },
};

export default async function AdminWinbackPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const rows = await listWinbackCampaigns(ctx, await getDb());
  const live = rows.filter((r) => r.status === "approved" || r.status === "sending");

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Win-back emails</h1>
        <span>
          {live.length} scheduled or sending · {rows.length} approved in all
        </span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Campaigns</h2>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <p>No client has approved a win-back email yet.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Results</th>
                  <th>
                    <span className="sr-only">Stop</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.publicId}>
                    <td data-label="Client">
                      {r.clientPublicId ? <Link href={`/admin/clients/${r.clientPublicId}`}>{r.businessName}</Link> : r.businessName}
                    </td>
                    <td data-label="Email">
                      <strong>{r.name}</strong>
                      <br />
                      <span className="muted">{r.subject}</span>
                    </td>
                    <td data-label="Status">
                      <CampaignStatusPill status={r.status} scheduledFor={r.scheduledFor} />
                      {r.haltReason && <div className="muted">{r.haltReason}</div>}
                    </td>
                    <td data-label="When">
                      {r.sentAt
                        ? `Finished ${formatDateTime(r.sentAt)}`
                        : r.scheduledFor
                          ? `From ${formatDateWithYear(r.scheduledFor)}, 9am`
                          : r.approvedAt
                            ? `Approved ${formatDateTime(r.approvedAt)}`
                            : "—"}
                      {r.approvedByName && <div className="muted">by {r.approvedByName}</div>}
                    </td>
                    <td data-label="Results">
                      {r.stats.total === 0
                        ? "Not started"
                        : `${r.stats.sent}/${r.stats.total} sent · ${r.stats.delivered} delivered · ${r.stats.opened} opened · ${r.stats.clicked} clicked`}
                      {(r.stats.unsubscribed > 0 || r.stats.bounced > 0 || r.stats.complained > 0) && (
                        <div className="muted">
                          {r.stats.unsubscribed} unsubscribed · {r.stats.bounced} bounced · {r.stats.complained} spam
                        </div>
                      )}
                      {r.stats.notSent > 0 && <div className="muted">{r.stats.notSent} not emailed (no mail provider)</div>}
                    </td>
                    <td data-label="">
                      {(r.status === "approved" || r.status === "sending") && <HaltCampaignForm publicId={r.publicId} label={r.name} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Stop everything</h2>
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            Halts every scheduled and sending campaign for every client. Emails already sent stay sent. Clients see the
            reason on each campaign and would have to approve a new one.
          </p>
          <HaltAllForm />
        </div>
      </section>
    </main>
  );
}
