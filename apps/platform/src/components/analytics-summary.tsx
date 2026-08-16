import type { AnalyticsState, AnalyticsSummary } from "@/lib/analytics/umami";
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

/** The four headline numbers, in plain language rather than analytics jargon. */
export function StatRow({ data }: { data: AnalyticsSummary }) {
  return (
    <div className="grid grid-4">
      <Stat
        label="Visitors"
        value={data.visitors.toLocaleString("en-US")}
        note="people, not visits"
      />
      <Stat
        label="Page views"
        value={data.pageviews.toLocaleString("en-US")}
        note="pages opened"
      />
      <Stat
        label="Typical visit"
        value={formatDuration(data.avgSecondsOnSite)}
        note="time on the site"
      />
      <Stat
        label="Left straight away"
        value={`${Math.round(data.bounceRate * 100)}%`}
        note="saw one page only"
      />
    </div>
  );
}
