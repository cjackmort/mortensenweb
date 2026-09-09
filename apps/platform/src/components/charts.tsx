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
 * Visits and pageviews over time.
 *
 * Two series on ONE axis — both are counts of the same kind, so a shared scale
 * is honest. A second y-axis would let the two lines cross wherever the scales
 * happened to put them, which invents a relationship that is not in the data.
 *
 * Honest, but not always legible: pageviews typically run two to five times
 * visits, so the visits line sits squashed against the bottom and its trend —
 * the thing a client actually wants — is the hardest part to read. The answer
 * is a *metric toggle* rather than a second axis: `metric` renders one series
 * on its own scale, where a change of twenty percent looks like a change of
 * twenty percent.
 *
 * When the provider sends no per-day visits, the visits series is absent
 * entirely rather than drawn as zeroes. A flat line along the bottom labelled
 * "visits" is a silent zero, and this codebase keeps having to remove those.
 *
 * `gradientId` exists because SVG gradient ids are document-global: two charts
 * on one page sharing an id means the second silently paints with the first
 * one's fill. The dashboard now draws two, so the second passes its own id;
 * the default is the first one's, and any third chart needs one of its own.
 */
export type ChartMetric = "both" | "visits" | "pageviews";

export function TimeSeriesChart({
  series,
  labelled = true,
  metric = "both",
  gradientId = "chart-area-fade",
}: {
  series: SeriesPoint[];
  labelled?: boolean;
  /** Which series to draw. One at a time gets its own scale. */
  metric?: ChartMetric;
  gradientId?: string;
}) {
  if (series.length === 0) return null;

  // Absent, not zero. `visits: null` means the provider sent no per-day series,
  // and drawing that as a flat line would be an invented figure.
  const hasVisits = series.some((p) => p.visits !== null);
  const showVisits = metric !== "pageviews" && hasVisits;
  const showPageviews = metric !== "visits";
  const visitAt = (p: SeriesPoint) => p.visits ?? 0;

  /*
   * Nothing to draw, so nothing is drawn.
   *
   * The dashboard's first chart asks for `visits` alone, and some builds of the
   * provider's pageviews endpoint send no per-day session series at all. Every
   * line was then suppressed but the frame was not: a grid, an axis running 0
   * to 1, and no data — which reads as a real chart of a site nobody visited
   * rather than as a figure we never received.
   */
  if (!showVisits && !showPageviews) return null;

  const W = 720;
  const H = 220;
  const pad = { top: 16, right: 16, bottom: 28, left: 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  /*
   * Scaled to what is actually drawn.
   *
   * With one series selected the axis belongs to it alone, which is the whole
   * point of the toggle: on a shared scale a visits line under a pageviews
   * line is compressed into the bottom fifth of the chart and its shape is
   * unreadable.
   */
  const max = niceCeiling(
    Math.max(
      1,
      ...series.map((p) =>
        Math.max(
          showPageviews ? p.pageviews : 0,
          showVisits ? visitAt(p) : 0,
        ),
      ),
    ),
  );

  const x = (i: number) =>
    pad.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;

  const path = (key: "visits" | "pageviews") =>
    series
      .map((p, i) => {
        const value = key === "visits" ? visitAt(p) : p.pageviews;
        return `${i === 0 ? "M" : "L"}${x(i)},${y(value)}`;
      })
      .join(" ");

  // The filled area follows whichever series is the primary one on screen.
  const areaKey: "visits" | "pageviews" = showVisits ? "visits" : "pageviews";
  const areaPath = `${path(areaKey)} L${x(series.length - 1)},${pad.top + plotH} L${x(0)},${pad.top + plotH} Z`;

  /*
   * What this chart actually plots, said out loud.
   *
   * Two charts now sit side by side on the dashboard, and both used to carry
   * the label "Visitors and pageviews" — so a screen-reader user heard the same
   * sentence twice with no way to tell which was which, and the visits chart
   * announced itself as *visitors*. Those are the two figures this whole change
   * exists to stop conflating, so getting it wrong in the accessible name would
   * undo the fix for exactly the people who cannot see the heading above it.
   */
  const drawn = [showVisits && "visits", showPageviews && "page views"]
    .filter(Boolean)
    .join(" and ");

  const ticks = [0, max / 2, max];
  // At most six date labels, so they never collide on a narrow screen.
  const step = Math.max(1, Math.ceil(series.length / 6));
  const last = series[series.length - 1]!;

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Daily ${drawn} over the last ${series.length} days`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {/* Vertical fade under the visitors line. Stop colours are set in
              CSS so the gradient follows light and dark like everything else. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="chart-grad-from" />
            <stop offset="100%" className="chart-grad-to" />
          </linearGradient>
        </defs>

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

        <path d={areaPath} className="chart-area" fill={`url(#${gradientId})`} />
        {showPageviews && (
          <path d={path("pageviews")} className="chart-line chart-series-2" />
        )}
        {showVisits && (
          <path d={path("visits")} className="chart-line chart-series-1" />
        )}

        {/* Direct label on the final point: the value people actually look for,
            available without hovering, which phones cannot do. */}
        {labelled && (
          <>
            <circle
              cx={x(series.length - 1)}
              cy={y(showVisits ? visitAt(last) : last.pageviews)}
              r={4}
              className={`chart-dot ${showVisits ? "chart-series-1" : "chart-series-2"}`}
            />
            <title>
              {`Most recent day: ${
                hasVisits ? `${visitAt(last)} visits, ` : ""
              }${last.pageviews} page views`}
            </title>
          </>
        )}
      </svg>

      <figcaption className="chart-legend">
        {showVisits && (
          <span>
            <i className="swatch chart-series-1" aria-hidden="true" /> Visits
          </span>
        )}
        {showPageviews && (
          <span>
            <i className="swatch chart-series-2" aria-hidden="true" /> Page views
          </span>
        )}
        {/* Said out loud rather than left as a missing line. A client comparing
            this with last month needs to know the series is absent, not zero. */}
        {!hasVisits && (
          <span className="muted">
            Per-day visits were not returned for this period.
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * The shape of a run of days, beside the number that counts them.
 *
 * Deliberately axis-less. A sparkline answers "climbing or falling", not "how
 * many" — the figure next to it already answers that, and the full chart with
 * real axes is a few hundred pixels below. Adding ticks would turn it into a
 * chart too small to read from.
 *
 * Hidden from assistive technology on purpose: the trend it draws is stated in
 * words by the delta beside it, so announcing it again would be one fact read
 * out twice. `id` is required rather than defaulted because several of these
 * render on one page and SVG gradient ids are document-global.
 */
export function Sparkline({
  values,
  id,
}: {
  values: number[];
  id: string;
}) {
  // Two points is the minimum that can slope. One is a dot with no trend, and
  // drawing it would imply a flat line that the data does not support.
  if (values.length < 2) return null;

  const W = 84;
  const H = 30;
  const inset = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  // A flat run would divide by zero and collapse to the top edge; centre it.
  const span = max - min || 1;

  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) =>
    max === min ? H / 2 : inset + (1 - (v - min) / span) * (H - inset * 2);

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const lastIndex = values.length - 1;

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="chart-grad-from" />
          <stop offset="100%" className="chart-grad-to" />
        </linearGradient>
      </defs>
      <path d={area} className="spark-area" fill={`url(#${id})`} />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={x(lastIndex)} cy={y(values[lastIndex]!)} r={2} className="spark-dot" />
    </svg>
  );
}

/**
 * A ranked breakdown.
 *
 * One colour for every bar, deliberately. Rank is already encoded by length and
 * order; colouring each bar differently would imply a categorical identity that
 * does not exist, and would burn a palette slot per row.
 *
 * The share of the total is shown beside the count because the count alone is
 * not usable: "29" is meaningless until you know whether that is a quarter of
 * the traffic or all of it. It comes out of the same numbers, so it costs
 * nothing and invents nothing.
 */
export function BarList({
  rows,
  unit,
  showShare = true,
}: {
  rows: Breakdown[];
  unit: string;
  showShare?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        Nothing recorded in this period.
      </p>
    );
  }

  const max = Math.max(...rows.map((r) => r.value), 1);
  // Share of what is listed, which is not always share of everything: these
  // breakdowns are the top handful of rows, so a long tail is excluded from
  // the denominator as well as from the list.
  const total = rows.reduce((sum, r) => sum + r.value, 0);

  return (
    <ul className="barlist">
      {rows.map((row) => {
        const share = total > 0 ? Math.round((row.value / total) * 100) : 0;
        return (
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
              {showShare && total > 0 && (
                <span className="barlist-share">
                  {share}
                  <span aria-hidden="true">%</span>
                  <span className="sr-only"> percent of those listed</span>
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A labelled figure per row.
 *
 * For measures that share no unit with each other — a duration next to a rate
 * next to a count. Bars would rank them against one another, which is a
 * comparison the numbers do not support.
 */
export function StatLines({
  rows,
}: {
  rows: { label: string; value: string; note?: string }[];
}) {
  return (
    <ul className="statline">
      {rows.map((row) => (
        <li key={row.label}>
          <span className="statline-label">{row.label}</span>
          <span className="statline-figure">
            {row.note && <span className="barlist-share">{row.note}</span>}
            {row.value}
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
              <th>Visits</th>
              <th>Page views</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => (
              <tr key={p.date}>
                <td data-label="Day">{formatDay(p.date)}</td>
                {/* An em dash, not a zero: the provider sent no figure. */}
                <td data-label="Visits">{p.visits ?? "—"}</td>
                <td data-label="Page views">{p.pageviews}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
