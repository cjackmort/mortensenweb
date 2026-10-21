import Link from "next/link";
import { adChannel } from "@mortensenweb/plans";
import { BarList, formatDay } from "@/components/charts";
import type { CampaignResults } from "@/db/repositories/client/ad-report";
import { formatDateTime } from "@/lib/time";
import { AdDailyChart, type DailyMetric } from "./daily-chart";
import { formatCents } from "./checkout-lines";

const METRICS: Array<{ key: DailyMetric; label: string }> = [
  { key: "clicks", label: "Clicks" },
  { key: "impressions", label: "Views" },
  { key: "spend", label: "Spend" },
];

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function micros(value: number | null): string {
  return value === null ? "—" : formatCents(Math.round(value / 10_000));
}

/**
 * How a campaign is doing, and where it was seen.
 *
 * Says plainly when there is nothing to show and why, because to someone who
 * has paid, "no figures yet" and "nobody saw your ad" mean opposite things. A
 * running ad the portal cannot read yet is never drawn as a row of zeros.
 */
export function AdResults({
  results,
  metric,
  hrefFor,
}: {
  results: CampaignResults;
  metric: DailyMetric;
  /** The same page with another chart metric chosen. */
  hrefFor: (metric: DailyMetric) => string;
}) {
  if (results.state === "not_started") return null;

  if (results.state === "not_connected") {
    return (
      <section className="card">
        <h2>How it&rsquo;s doing</h2>
        <p className="notice notice-info">
          Your ad is running. Its results aren&rsquo;t connected to your portal yet, so they don&rsquo;t show here.
          Until they are, ask us any time and we&rsquo;ll send you the figures from Google and Meta.
        </p>
      </section>
    );
  }

  if (results.state === "waiting") {
    return (
      <section className="card">
        <h2>How it&rsquo;s doing</h2>
        <p className="notice notice-info">
          Your ad is live. Google and Meta report a few hours behind, so the first figures show here within a day.
        </p>
      </section>
    );
  }

  const { report } = results;
  const spentCents = Math.round(results.spentMicros / 10_000);
  const share = results.budgetCents > 0 ? Math.min(100, (spentCents / results.budgetCents) * 100) : 0;
  const google = report.placements.filter((p) => p.platform === "google_ads");
  const meta = report.placements.filter((p) => p.platform === "meta");
  const googlePlaces = report.locations.filter((l) => l.platform === "google_ads");
  const metaPlaces = report.locations.filter((l) => l.platform === "meta");

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>How it&rsquo;s doing</h2>
          {results.lastSyncedAt && <span className="muted">Updated {formatDateTime(results.lastSyncedAt)}</span>}
        </div>

        <div className="ad-meter" role="img" aria-label={`Spent ${formatCents(spentCents)} of ${formatCents(results.budgetCents)}`}>
          <div className="ad-meter-head">
            <span>
              <strong>{formatCents(spentCents)}</strong> spent
            </span>
            <span className="muted">of {formatCents(results.budgetCents)} budget</span>
          </div>
          <span className="barlist-track" aria-hidden="true">
            <span className="barlist-fill" style={{ width: `${Math.max(1, share)}%` }} />
          </span>
        </div>

        <div className="grid grid-4 ad-stats">
          <div className="stat">
            <p className="stat-label">Views</p>
            <p className="stat-value">{report.totals.impressions.toLocaleString("en-US")}</p>
            <p className="stat-note">times your ad was shown</p>
          </div>
          <div className="stat">
            <p className="stat-label">Clicks</p>
            <p className="stat-value">{report.totals.clicks.toLocaleString("en-US")}</p>
            <p className="stat-note">{percent(report.totals.ctr)} of views</p>
          </div>
          <div className="stat">
            <p className="stat-label">Cost per click</p>
            <p className="stat-value">{micros(report.totals.cpcMicros)}</p>
            <p className="stat-note">ad spend ÷ clicks</p>
          </div>
          <div className="stat">
            <p className="stat-label">Calls and leads</p>
            <p className="stat-value">{(report.totals.calls + report.totals.leads).toLocaleString("en-US")}</p>
            <p className="stat-note">
              {report.totals.calls} {report.totals.calls === 1 ? "call" : "calls"} · {report.totals.leads}{" "}
              {report.totals.leads === 1 ? "lead form" : "lead forms"}
            </p>
          </div>
        </div>
        {report.totals.conversions > 0 && (
          <p className="field-hint">
            Google and Meta also count {report.totals.conversions.toLocaleString("en-US")} conversions, by their own
            rules. Google can split one between several clicks, which is why it can be a fraction.
          </p>
        )}

        <div className="panel-head ad-chart-head">
          <h3>Each day</h3>
          <nav className="segmented" aria-label="What the chart shows">
            {METRICS.map((m) => (
              <Link key={m.key} href={hrefFor(m.key)} aria-current={m.key === metric ? "true" : undefined} scroll={false}>
                {m.label}
              </Link>
            ))}
          </nav>
        </div>
        <AdDailyChart days={report.daily} metric={metric} />

        <details className="chart-table">
          <summary>View these numbers as a table</summary>
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Views</th>
                  <th>Clicks</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {report.daily.map((d) => (
                  <tr key={d.day}>
                    <td data-label="Day">{formatDay(d.day)}</td>
                    <td data-label="Views">{d.impressions.toLocaleString("en-US")}</td>
                    <td data-label="Clicks">{d.clicks.toLocaleString("en-US")}</td>
                    <td data-label="Spend">{micros(d.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="card">
        <h2>Where it was seen</h2>
        <div className={`panel-split ${google.length && meta.length ? "panel-split-2" : ""}`}>
          {google.length > 0 && (
            <div>
              <h3>On Google</h3>
              <BarList rows={google.map((p) => ({ label: p.label, value: p.impressions }))} unit="views" />
            </div>
          )}
          {meta.length > 0 && (
            <div>
              <h3>On Facebook and Instagram</h3>
              <BarList rows={meta.map((p) => ({ label: p.label, value: p.impressions }))} unit="views" />
            </div>
          )}
          {google.length === 0 && meta.length === 0 && (
            <p className="muted">The platforms haven&rsquo;t broken these views down by placement yet.</p>
          )}
        </div>
        <p className="panel-note">Views, by where your ad appeared. Percentages are of the views listed.</p>
      </section>

      <section className="card">
        <h2>Where people were</h2>
        <div className={`panel-split ${googlePlaces.length && metaPlaces.length ? "panel-split-2" : ""}`}>
          {googlePlaces.length > 0 && (
            <div>
              <h3>On Google, by town</h3>
              <BarList rows={googlePlaces.map((l) => ({ label: l.label, value: l.impressions }))} unit="views" />
            </div>
          )}
          {metaPlaces.length > 0 && (
            <div>
              <h3>On Facebook and Instagram, by region</h3>
              <BarList rows={metaPlaces.map((l) => ({ label: l.label, value: l.impressions }))} unit="views" />
            </div>
          )}
          {googlePlaces.length === 0 && metaPlaces.length === 0 && (
            <p className="muted">The platforms haven&rsquo;t broken these views down by place yet.</p>
          )}
        </div>
        <p className="panel-note">
          Where Google and Meta placed each viewer. Meta only says which state or region. Some views can&rsquo;t be
          placed at all, so these can add up to fewer than the total.
        </p>
      </section>

      <p className="panel-note">
        Running on{" "}
        {results.channels
          .map((c) => `${adChannel(c.channel).name}${c.connected ? "" : " (results not connected)"}`)
          .join(", ")}
        .
      </p>
    </>
  );
}
