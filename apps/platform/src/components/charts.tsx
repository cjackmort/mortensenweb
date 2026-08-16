import type { Breakdown, SeriesPoint } from "@/lib/analytics/umami";

/**
 * Charts, rendered as inline SVG on the server.
 *
 * No charting library and no client JavaScript. Three reasons, in order of
 * weight: the audience is on a phone over cell data and a chart library is a
 * large download to draw ten bars; the CSP forbids external script anyway; and
 * a server-rendered chart is visible on first paint rather than after hydration.
 *
 * Interaction is deliberately *not* hover-based. Hover does not exist on the
 * device most of these clients use, so identity comes from direct labels and a
 * table view rather than a tooltip. `<title>` gives desktop users a native
 * tooltip and screen readers an accessible name at no cost.
 *
 * Colours come from CSS custom properties defined in globals.css, so light and
 * dark each use their own validated steps rather than one set being an
 * automatic flip of the other.
 */

function niceCeiling(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * Umami returns a full ISO timestamp (`2026-08-16T06:00:00Z`) for a daily
 * bucket, not a bare date. Appending `T00:00:00Z` to that produces an invalid
 * date and an axis full of "Invalid Date", so the bare-date case is detected by
 * length rather than assumed. The raw string is returned unchanged if it still
 * will not parse — a visible oddity beats a crash mid-render.
 */
function formatDay(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Visitors and pageviews over time.
 *
 * Two series on ONE axis — both are counts of the same kind, so a shared scale
 * is honest. A second y-axis would let the two lines cross wherever the scales
 * happened to put them, which invents a relationship that is not in the data.
 */
export function TimeSeriesChart({
  series,
  labelled = true,
}: {
  series: SeriesPoint[];
  labelled?: boolean;
}) {
  if (series.length === 0) return null;

  const W = 720;
  const H = 220;
  const pad = { top: 16, right: 16, bottom: 28, left: 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const max = niceCeiling(
    Math.max(1, ...series.map((p) => Math.max(p.pageviews, p.visitors))),
  );

  const x = (i: number) =>
    pad.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;

  const path = (key: "visitors" | "pageviews") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p[key])}`).join(" ");

  const areaPath = `${path("visitors")} L${x(series.length - 1)},${pad.top + plotH} L${x(0)},${pad.top + plotH} Z`;

  const ticks = [0, max / 2, max];
  // At most six date labels, so they never collide on a narrow screen.
  const step = Math.max(1, Math.ceil(series.length / 6));
  const last = series[series.length - 1]!;

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Visitors and pageviews over the last ${series.length} days`}
        preserveAspectRatio="xMidYMid meet"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={y(t)}
              y2={y(t)}
              className="chart-grid"
            />
            <text x={pad.left - 8} y={y(t) + 4} className="chart-tick" textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}

        {series.map((p, i) =>
          i % step === 0 || i === series.length - 1 ? (
            <text
              key={p.date}
              x={x(i)}
              y={H - 8}
              className="chart-tick"
              textAnchor={i === series.length - 1 ? "end" : "middle"}
            >
              {formatDay(p.date)}
            </text>
          ) : null,
        )}

        <path d={areaPath} className="chart-area" />
        <path d={path("pageviews")} className="chart-line chart-series-2" />
        <path d={path("visitors")} className="chart-line chart-series-1" />

        {/* Direct label on the final point: the value people actually look for,
            available without hovering, which phones cannot do. */}
        {labelled && (
          <>
            <circle
              cx={x(series.length - 1)}
              cy={y(last.visitors)}
              r={4}
              className="chart-dot chart-series-1"
            />
            <title>
              {`Most recent day: ${last.visitors} visitors, ${last.pageviews} pageviews`}
            </title>
          </>
        )}
      </svg>

      <figcaption className="chart-legend">
        <span>
          <i className="swatch chart-series-1" aria-hidden="true" /> Visitors
        </span>
        <span>
          <i className="swatch chart-series-2" aria-hidden="true" /> Pageviews
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * A ranked breakdown.
 *
 * One colour for every bar, deliberately. Rank is already encoded by length and
 * order; colouring each bar differently would imply a categorical identity that
 * does not exist, and would burn a palette slot per row.
 */
export function BarList({
  rows,
  unit,
}: {
  rows: Breakdown[];
  unit: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        Nothing recorded in this period.
      </p>
    );
  }

  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="barlist">
      {rows.map((row) => (
        <li key={row.label}>
          <span className="barlist-label" title={row.label}>
            {row.label}
          </span>
          <span className="barlist-track" aria-hidden="true">
            <span
              className="barlist-fill"
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
            />
          </span>
          <span className="barlist-value">
            {row.value.toLocaleString("en-US")}
            <span className="sr-only"> {unit}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The table view.
 *
 * Required rather than optional: it is the fallback when colour cannot be
 * distinguished, when a screen reader is reading the page, and when someone
 * simply wants the numbers.
 */
export function SeriesTable({ series }: { series: SeriesPoint[] }) {
  return (
    <details className="chart-table">
      <summary>View these numbers as a table</summary>
      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              <th>Day</th>
              <th>Visitors</th>
              <th>Pageviews</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => (
              <tr key={p.date}>
                <td data-label="Day">{formatDay(p.date)}</td>
                <td data-label="Visitors">{p.visitors}</td>
                <td data-label="Pageviews">{p.pageviews}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
