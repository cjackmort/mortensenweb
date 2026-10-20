import { listClientCampaigns } from "@/db/repositories/admin/campaigns";
import type { AdminContext } from "@/db/repositories/context";
import { getDb } from "@/db/client";
import { formatDateWithYear } from "@/lib/time";

/**
 * The client's QR campaigns: what they have printed, and whether anyone is
 * scanning it. Read-only here — campaigns are the client's to run.
 */
export async function CampaignsPanel({ ctx, clientPublicId }: { ctx: AdminContext; clientPublicId: string }) {
  const rows = await listClientCampaigns(ctx, await getDb(), clientPublicId);

  return (
    <section className="card" id="campaigns">
      <div className="card-head">
        <h2>QR campaigns</h2>
        <span className="muted">{rows.length === 0 ? "None yet" : `${rows.length} in all`}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No campaigns yet. The client makes them under Growth → Campaigns.</p>
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Short link</th>
                <th>Scans, 30 days</th>
                <th>All time</th>
                <th>Last scan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.publicId}>
                  <td data-label="Campaign">
                    {row.name}
                    <span className="campaign-meta">
                      {row.placementLabel} · {row.siteName}
                      {row.paused && <span className="pill pill-neutral">Paused</span>}
                    </span>
                  </td>
                  <td data-label="Short link">
                    <code>{row.printedLink}</code>
                  </td>
                  <td data-label="Scans, 30 days">{row.scansInWindow.toLocaleString("en-US")}</td>
                  <td data-label="All time">{row.scansTotal.toLocaleString("en-US")}</td>
                  <td data-label="Last scan">{row.lastScanAt ? formatDateWithYear(row.lastScanAt) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
