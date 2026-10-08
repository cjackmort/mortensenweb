"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { TimeSeriesChartSvg } from "./charts";

/**
 * The daily chart, drawn at the width it is actually shown.
 *
 * An SVG with a fixed viewBox scales everything inside it, text included, so
 * the same 720-wide drawing printed its dates at 11px on a full-width page,
 * about 7px in the dashboard's half-width columns, and smaller again on a
 * phone or a client tile. Measuring the container and redrawing at that width
 * keeps the dates at their real size and lets the chart choose how many fit.
 *
 * The server renders the 720 version; the first measurement replaces it
 * before anyone reads a date.
 */
export function TimeSeriesChart(props: Omit<ComponentProps<typeof TimeSeriesChartSvg>, "width">) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      // Ignore a zero width (a hidden tab, a collapsed section): drawing at
      // the floor size and then snapping back is a flicker for nothing.
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={holder}>
      <TimeSeriesChartSvg {...props} width={width} />
    </div>
  );
}
