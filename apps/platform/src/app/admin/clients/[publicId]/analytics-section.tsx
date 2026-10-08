import { StatRow } from "@/components/analytics-summary";
import { TimeSeriesChart } from "@/components/time-series-chart";
import { demoAnalytics } from "@/lib/analytics/demo";
import { demoReason } from "@/lib/analytics/resolve";
import { fetchAnalytics, isUmamiConfigured, type AnalyticsState } from "@/lib/analytics/umami";
import { ConnectAnalyticsForm } from "./site-forms";
import type { SiteRow } from "./website-section";

/**
 * The figures the client sees on their own dashboard, read here directly.
 *
 * Fetched only when this section is open: each one is a call to Umami, and
 * the rest of the client page has no reason to wait for it. Shown before a
 * website ID is set too, as sample data with an honest label, so the section
 * never looks unbuilt.
 */
export async function AnalyticsSection({
  clientPublicId,
  sites,
}: {
  clientPublicId: string;
  sites: SiteRow[];
}) {
  const umamiReady = isUmamiConfigured();
  const snapshots = await Promise.all(
    sites.map(async (site) => {
      const state: AnalyticsState = site.umamiWebsiteId
        ? await fetchAnalytics(site.umamiWebsiteId, 30)
        : umamiReady
          ? { kind: "not_connected" }
          : { kind: "not_configured" };
      return {
        site,
        reason: demoReason(state),
        data: state.kind === "ok" ? state.data : demoAnalytics(site.publicId, 30),
      };
    }),
  );

  return (
    <>
      {!umamiReady && (
        <p className="notice">
          <strong>The portal has no Umami credentials yet.</strong> You can record website IDs
          now, but no figures load until <code>UMAMI_API_BASE_URL</code> and{" "}
          <code>UMAMI_API_KEY</code> are set.
        </p>
      )}

      {sites.length === 0 && (
        <p className="muted">Analytics attaches to a site. Add one under Website first.</p>
      )}

      {snapshots.map(({ site, reason, data }) => (
        <section key={site.publicId} className="card">
          <div className="card-head">
            <h2>{site.name}</h2>
            <span className={`pill ${site.umamiWebsiteId ? "pill-success" : "pill-neutral"}`}>
              {site.umamiWebsiteId ? "connected" : "not connected"}
            </span>
          </div>

          {reason && (
            <p className="notice" style={{ marginBottom: "1rem" }}>
              <span className="badge">Sample data</span> {reason}
            </p>
          )}
          <StatRow data={data} comparedTo="previous 30 days" />
          <div style={{ margin: "1rem 0 1.75rem" }}>
            <TimeSeriesChart series={data.series} />
          </div>

          <ConnectAnalyticsForm
            clientPublicId={clientPublicId}
            sitePublicId={site.publicId}
            currentWebsiteId={site.umamiWebsiteId}
          />
        </section>
      ))}
    </>
  );
}
