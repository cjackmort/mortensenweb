import Link from "next/link";
import { redirect } from "next/navigation";
import { adChannel } from "@mortensenweb/plans";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { adsOverview, feeKeptCents, listAdminCampaigns, type AdminCampaignRow } from "@/db/repositories/admin/ads";
import { GOOGLE_ADS_ENV, googleAdsConfigured } from "@/lib/ads/google-ads";
import { META_ENV, metaConfigured } from "@/lib/ads/meta";
import { campaignDates } from "@/lib/ads/dates";
import { CampaignStatusPill } from "@/components/ads/status";
import { formatCents } from "@/components/ads/checkout-lines";
import "@/components/ads/ads.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Ads", robots: { index: false, follow: false } };

/**
 * Every client's paid ads, in the order the operator has to act on them:
 * waiting for review, ready to launch, running, needing settlement. The
 * figures across the top are the business side — what clients have paid for,
 * what has been spent, and what the fee has earned.
 */
export default async function AdminAdsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const rows = await listAdminCampaigns(ctx, await getDb());
  const overview = adsOverview(rows);

  const queues: Array<{ title: string; note: string; rows: AdminCampaignRow[] }> = [
    {
      title: "Waiting for review",
      note: "Paid. Check each against Google's and Meta's ad policies.",
      rows: rows.filter((r) => r.status === "pending_review"),
    },
    {
      title: "Ready to launch",
      note: "Approved. Set each channel up and paste its ids.",
      rows: rows.filter((r) => r.status === "approved"),
    },
    { title: "Running", note: "", rows: rows.filter((r) => r.status === "active" || r.status === "paused") },
    {
      title: "Needs settling",
      note: "Ended or cancelled, and the refund of anything unspent hasn't been done.",
      rows: rows.filter((r) => (r.status === "ended" || r.status === "cancelled") && r.paidAt && !r.settledAt),
    },
    { title: "Sent back to the client", note: "", rows: rows.filter((r) => r.status === "rejected") },
    {
      title: "Settled",
      note: "",
      rows: rows.filter((r) => (r.status === "ended" || r.status === "cancelled") && r.settledAt).slice(0, 20),
    },
  ];

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Ads</h1>
        <span>Every client&rsquo;s campaigns</span>
      </div>

      <div className="grid grid-4">
        <div className="stat">
          <p className="stat-label">Ad spend paid for</p>
          <p className="stat-value">{formatCents(overview.paidSpendCents)}</p>
          <p className="stat-note">goes to Google and Meta at cost</p>
        </div>
        <div className="stat">
          <p className="stat-label">Spent so far</p>
          <p className="stat-value">{formatCents(overview.spentCents)}</p>
          <p className="stat-note">as the platforms report it</p>
        </div>
        <div className="stat">
          <p className="stat-label">Fee revenue</p>
          <p className="stat-value">{formatCents(overview.feeRevenueCents)}</p>
          <p className="stat-note">on campaigns that ran</p>
        </div>
        <div className="stat">
          <p className="stat-label">Running now</p>
          <p className="stat-value">{overview.activeCampaigns}</p>
          <p className="stat-note">
            {overview.needsReview} to review · {overview.readyToLaunch} to launch · {overview.refundsDue} to settle
          </p>
        </div>
      </div>

      <section className="card">
        <h2>Connections</h2>
        <dl className="detail-grid">
          <dt>Google Ads</dt>
          <dd>
            {googleAdsConfigured() ? (
              <span className="pill pill-success">Connected</span>
            ) : (
              <>
                <span className="pill pill-neutral">Not connected</span> Manual mode: launch in Google Ads, paste the
                ids here. Results sync once {GOOGLE_ADS_ENV.join(", ")} are set.
              </>
            )}
          </dd>
          <dt>Meta</dt>
          <dd>
            {metaConfigured() ? (
              <span className="pill pill-success">Connected</span>
            ) : (
              <>
                <span className="pill pill-neutral">Not connected</span> Manual mode: launch in Ads Manager, paste the
                ids here. Results sync once {META_ENV.join(", ")} are set.
              </>
            )}
          </dd>
        </dl>
        {overview.refundedCents > 0 && <p className="panel-note">Refunded to clients so far: {formatCents(overview.refundedCents)}.</p>}
      </section>

      {queues.map((queue) =>
        queue.rows.length === 0 ? null : (
          <section className="card" key={queue.title}>
            <div className="card-head">
              <h2>{queue.title}</h2>
              <span className="muted">{queue.rows.length}</span>
            </div>
            {queue.note && <p className="muted">{queue.note}</p>}
            <div className="table-wrap">
              <table className="stack ad-admin-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Campaign</th>
                    <th>Where</th>
                    <th>Spend</th>
                    <th>Fee</th>
                    <th>Dates</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.rows.map((r) => {
                    const failing = r.channels.find((c) => c.syncError);
                    return (
                      <tr key={r.publicId}>
                        <td data-label="Client">{r.clientName}</td>
                        <td data-label="Campaign">
                          <Link href={`/admin/ads/${r.publicId}`}>{r.name}</Link>
                        </td>
                        <td data-label="Where">{r.channels.map((c) => adChannel(c.channel).name).join(", ")}</td>
                        <td data-label="Spend">
                          {formatCents(Math.round(r.channels.reduce((n, c) => n + c.spendMicros, 0) / 10_000))} of{" "}
                          {formatCents(r.spendBudgetCents)}
                        </td>
                        <td data-label="Fee">{formatCents(r.launchedAt ? feeKeptCents(r) : r.managementFeeCents)}</td>
                        <td data-label="Dates">{campaignDates(r) ?? "—"}</td>
                        <td data-label="Status">
                          <CampaignStatusPill status={r.status} />
                          {failing && <span className="error ad-admin-syncerror"> Sync failing</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ),
      )}

      {rows.length === 0 && (
        <p className="empty">No paid campaigns yet. They appear here as soon as a client pays for one.</p>
      )}
    </main>
  );
}
