import type { DayCount } from "@/db/repositories/client/campaign-stats";
import { formatDay } from "@/components/charts";

/**
 * Scans per day, as columns.
 *
 * Drawn without text inside the SVG, so it can stretch to any width without
 * squashing its labels; the dates and the peak sit in HTML beneath it. Only
 * ever rendered once something has been scanned — see `campaign-stats.ts`
 * for why thirty empty columns would be the wrong thing to show.
 */
export function ScanChart({ series, label }: { series: DayCount[]; label: string }) {
  const peak = Math.max(1, ...series.map((day) => day.scans));
  const total = series.reduce((sum, day) => sum + day.scans, 0);
  const first = series[0];
  const last = series[series.length - 1];
  const COLUMN = 10;
  const GAP = 2;
  const HEIGHT = 100;

  return (
    <figure className="scan-chart">
      <svg
        viewBox={`0 0 ${series.length * COLUMN} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${total} scans over ${series.length} days, at most ${peak} in a day.`}
      >
        {series.map((day, i) => {
          const height = day.scans === 0 ? 0 : Math.max(3, (day.scans / peak) * HEIGHT);
          return (
            <rect
              key={day.date}
              x={i * COLUMN + GAP / 2}
              y={HEIGHT - height}
              width={COLUMN - GAP}
              height={height}
            >
              <title>{`${formatDay(day.date)}: ${day.scans} ${day.scans === 1 ? "scan" : "scans"}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="scan-chart-axis">
        <span>{first ? formatDay(first.date) : ""}</span>
        <span>Busiest day: {peak.toLocaleString("en-US")}</span>
        <span>{last ? formatDay(last.date) : ""}</span>
      </figcaption>
    </figure>
  );
}

/** The code on screen, drawn from the same matrix as the downloads. */
export function QrPreview({ path, size, label }: { path: string; size: number; label: string }) {
  return (
    <svg
      className="qr-preview"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
