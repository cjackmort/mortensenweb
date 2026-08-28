import { Sparkline } from "@/components/charts";
import {
  percentChange,
  type AnalyticsState,
  type AnalyticsSummary,
} from "@/lib/analytics/umami";
import { demoReason } from "@/lib/analytics/resolve";

/**
 * The pieces of the analytics view that appear in more than one place.
 *
 * Kept here rather than duplicated so the dashboard summary and the Visitors
 * page can never disagree — including the demo banner, whose wording is the
 * part most likely to drift and the part it matters most to get identical.
 */

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="stat-note">{note}</p>
    </div>
  );
}

/**
 * Why the numbers are not real.
 *
 * §10 requires that an empty or broken state never render as a silent zero. It
 * follows that stand-in figures must be louder still: a plausible traffic chart
 * that is actually invented is worse than a blank page, because the client has
 * no way to tell.
 */
export function DemoBanner({ state }: { state: AnalyticsState }) {
  const reason = demoReason(state);
  if (!reason) return null;

  return (
    <p className={state.kind === "error" ? "notice notice-danger" : "notice"}>
      <span className="badge">Sample data</span>{" "}
      <strong>The figures below are made up.</strong> {reason} They are here so
      the layout can be reviewed, and will be replaced by real numbers once
      tracking is live.
    </p>
  );
}

/**
 * Change against the window before this one.
 *
 * Three things this gets right that a naive arrow does not:
 *
 * 1. **No comparison renders as nothing.** Not a zero, not a grey dash with a
 *    percentage — nothing at all. A site that has been live for a week has no
 *    previous thirty days, and inventing 0% would tell the client their traffic
 *    was flat when the truth is that we cannot say.
 * 2. **Up is not the same as good.** A rise in "left straight away" is a worse
 *    week. The caller says which direction is the good one and the colour
 *    follows that, not the sign.
 * 3. **The direction is in the text, not only the colour.** An arrow glyph for
 *    sighted readers who cannot separate red from green, and a spelled-out
 *    sentence for anyone listening to the page.
 */
export function Delta({
  change,
  higherIsBetter,
  comparedTo,
}: {
  change: number | null;
  higherIsBetter: boolean;
  comparedTo: string;
}) {
  if (change === null) return null;

  const percent = Math.round(Math.abs(change) * 100);

  // Under half a percent. Reporting "0%" alongside an arrow claims a direction
  // that rounding invented, so it becomes an explicit "no change".
  if (percent === 0) {
    return (
      <span className="delta delta-flat">
        <span aria-hidden="true">— 0%</span>
        <span className="sr-only">no change on the {comparedTo}</span>
      </span>
    );
  }

  const rising = change > 0;
  const good = rising === higherIsBetter;

  return (
    <span className={`delta ${good ? "delta-better" : "delta-worse"}`}>
      <span className="delta-arrow" aria-hidden="true">
        {rising ? "↑" : "↓"}
      </span>
      <span aria-hidden="true">{percent}%</span>
      <span className="sr-only">
        {rising ? "up" : "down"} {percent} percent on the {comparedTo}
      </span>
    </span>
  );
}

/** One headline figure: label, number, change, and the shape of the run. */
function Metric({
  label,
  value,
  note,
  change,
  higherIsBetter,
  comparedTo,
  spark,
  sparkId,
}: {
  label: string;
  value: string;
  note: string;
  change: number | null;
  higherIsBetter: boolean;
  comparedTo: string;
  spark?: number[];
  sparkId?: string;
}) {
  return (
    <div className="metric">
      <p className="metric-label">{label}</p>
      <div className="metric-main">
        <div className="metric-figure">
          <p className="metric-value">{value}</p>
          <Delta
            change={change}
            higherIsBetter={higherIsBetter}
            comparedTo={comparedTo}
          />
        </div>
        {spark && sparkId && (
          <div className="metric-spark">
            <Sparkline values={spark} id={sparkId} />
          </div>
        )}
      </div>
      <p className="metric-note">{note}</p>
    </div>
  );
}

/**
 * The four headline numbers, in plain language rather than analytics jargon.
 *
 * Only two of the four get a sparkline, and that asymmetry is deliberate.
 * Visitors and pageviews have a real per-day series behind them; typical visit
 * length and bounce rate do not — the analytics API returns them only as
 * period totals. Drawing a line for those would mean inventing the daily
 * values it passes through, which is exactly the kind of plausible fiction the
 * demo banner exists to prevent. They keep their change arrow, which is a fact
 * we actually have.
 */
export function StatRow({
  data,
  comparedTo,
}: {
  data: AnalyticsSummary;
  /** How the comparison window is described aloud, e.g. "previous 30 days". */
  comparedTo: string;
}) {
  const previous = data.previous;

  return (
    <div className="metrics">
      <Metric
        label="Visitors"
        value={data.visitors.toLocaleString("en-US")}
        note="people, not visits"
        change={previous ? percentChange(data.visitors, previous.visitors) : null}
        higherIsBetter
        comparedTo={comparedTo}
        spark={data.series.map((p) => p.visitors)}
        sparkId="spark-visitors"
      />
      <Metric
        label="Page views"
        value={data.pageviews.toLocaleString("en-US")}
        note="pages opened"
        change={previous ? percentChange(data.pageviews, previous.pageviews) : null}
        higherIsBetter
        comparedTo={comparedTo}
        spark={data.series.map((p) => p.pageviews)}
        sparkId="spark-pageviews"
      />
      <Metric
        label="Typical visit"
        value={formatDuration(data.avgSecondsOnSite)}
        note="time on the site"
        change={
          previous
            ? percentChange(data.avgSecondsOnSite, previous.avgSecondsOnSite)
            : null
        }
        higherIsBetter
        comparedTo={comparedTo}
      />
      <Metric
        label="Left straight away"
        value={`${Math.round(data.bounceRate * 100)}%`}
        note="saw one page only"
        // The one figure where a rise is bad news.
        change={previous ? percentChange(data.bounceRate, previous.bounceRate) : null}
        higherIsBetter={false}
        comparedTo={comparedTo}
      />
    </div>
  );
}
