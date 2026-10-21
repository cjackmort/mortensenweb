"use client";

import { useEffect, useRef, useState } from "react";
import { formatDay, niceCeiling } from "@/components/charts";
import type { ReportDay } from "@/lib/ads/report";

export type DailyMetric = "clicks" | "impressions" | "spend";

const LABEL: Record<DailyMetric, { one: string; many: string }> = {
  clicks: { one: "click", many: "clicks" },
  impressions: { one: "view", many: "views" },
  spend: { one: "spent", many: "spent" },
};

function valueOf(day: ReportDay, metric: DailyMetric): number {
  if (metric === "spend") return day.costMicros / 1_000_000;
  return metric === "clicks" ? day.clicks : day.impressions;
}

function say(value: number, metric: DailyMetric): string {
  if (metric === "spend") return `$${value.toFixed(2)} spent`;
  const words = LABEL[metric];
  return `${value.toLocaleString("en-US")} ${value === 1 ? words.one : words.many}`;
}

/**
 * One measure a day, on its own axis.
 *
 * Clicks, views and spend are three charts behind one switch rather than
 * three lines on one chart: they share no scale, and the only honest way to
 * draw two of them together is a second y-axis, which invents a relationship
 * where the lines happen to cross. The portal's visitor chart makes the same
 * choice for the same reason, and this uses its tokens and its marks.
 *
 * Every day has an invisible hit area with a native tooltip, larger than the
 * line itself, and the last day is labelled directly because it is the one
 * people look for and phones cannot hover.
 */
export function AdDailyChart({ days, metric }: { days: ReportDay[]; metric: DailyMetric }) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (days.length === 0) return null;

  const W = Math.max(240, width);
  const H = W < 480 ? 180 : 220;
  const pad = { top: 18, right: 16, bottom: 28, left: metric === "spend" ? 48 : 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const values = days.map((d) => valueOf(d, metric));
  const max = metric === "spend" ? Math.max(5, Math.ceil(Math.max(...values) / 5) * 5) : niceCeiling(Math.max(1, ...values));
  const x = (i: number) => pad.left + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const area = `${line} L${x(days.length - 1)},${pad.top + plotH} L${x(0)},${pad.top + plotH} Z`;
  const ticks = [0, max / 2, max];
  const tick = (t: number) => (metric === "spend" ? `$${Math.round(t)}` : Math.round(t).toLocaleString("en-US"));

  const labelSlots = Math.min(6, Math.max(2, Math.floor(plotW / 80)));
  const step = Math.max(1, Math.ceil(days.length / labelSlots));
  const last = days.length - 1;
  const showDate = (i: number) => i === last || (i % step === 0 && last - i >= step);
  const slot = plotW / Math.max(1, days.length - 1);
  const gradientId = `ad-chart-fade-${metric}`;

  return (
    <div ref={holder}>
      <figure className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${LABEL[metric].many} per day over ${days.length} days`}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="chart-grad-from" />
              <stop offset="100%" className="chart-grad-to" />
            </linearGradient>
          </defs>

          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.left - 8} y={y(t) + 4} className="chart-tick" textAnchor="end">
                {tick(t)}
              </text>
            </g>
          ))}

          {days.map((d, i) =>
            showDate(i) ? (
              <text key={d.day} x={x(i)} y={H - 8} className="chart-tick" textAnchor={i === last ? "end" : "middle"}>
                {formatDay(d.day)}
              </text>
            ) : null,
          )}

          <path d={area} className="chart-area" fill={`url(#${gradientId})`} />
          <path d={line} className="chart-line chart-series-1" />
          <circle cx={x(last)} cy={y(values[last]!)} r={4} className="chart-dot chart-series-1" />
          <text
            x={x(last)}
            y={Math.max(12, y(values[last]!) - 10)}
            className="chart-tick ad-chart-label"
            textAnchor="end"
          >
            {say(values[last]!, metric)}
          </text>

          {days.map((d, i) => (
            <rect
              key={`hit-${d.day}`}
              x={x(i) - slot / 2}
              y={pad.top}
              width={Math.max(slot, 8)}
              height={plotH}
              fill="transparent"
            >
              <title>{`${formatDay(d.day)}: ${say(values[i]!, metric)}`}</title>
            </rect>
          ))}
        </svg>
      </figure>
    </div>
  );
}
