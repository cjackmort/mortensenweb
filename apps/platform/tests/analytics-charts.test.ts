import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeSeriesChartSvg as TimeSeriesChart } from "@/components/charts";
import type { SeriesPoint } from "@/lib/analytics/umami";

/**
 * What a chart tells someone who cannot see it.
 *
 * The dashboard draws two charts one above the other — visits, then page views
 * — and both used to carry the accessible name "Visitors and pageviews over the
 * last 30 days". Two problems in one string: a screen-reader user heard the
 * identical sentence twice with no way to tell the charts apart, and the visits
 * chart announced itself as *visitors*.
 *
 * Visitors and visits are the two figures this whole change exists to stop
 * conflating. Getting it wrong in the accessible name would leave the fix
 * undone for precisely the people who cannot read the heading above the chart.
 */

function days(count: number, visits: number | null = 5): SeriesPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    pageviews: 10 + i,
    visits,
  }));
}

function labelOf(element: ReturnType<typeof createElement>): string {
  const markup = renderToStaticMarkup(element);
  return /aria-label="([^"]*)"/.exec(markup)?.[1] ?? "";
}

describe("the accessible name says what is drawn", () => {
  it("names only visits when only visits are plotted", () => {
    const label = labelOf(
      createElement(TimeSeriesChart, { series: days(30), metric: "visits" }),
    );
    expect(label).toContain("visits");
    // The bug: a chart of visits announcing itself as visitors. Matched
    // without regard to case, because the old label capitalised it.
    expect(label).not.toMatch(/visitor/i);
    expect(label).not.toContain("page views");
  });

  it("names only page views when only page views are plotted", () => {
    const label = labelOf(
      createElement(TimeSeriesChart, { series: days(30), metric: "pageviews" }),
    );
    expect(label).toContain("page views");
    expect(label).not.toContain("visits");
  });

  it("gives the two dashboard charts different names", () => {
    const series = days(30);
    const visits = labelOf(
      createElement(TimeSeriesChart, { series, metric: "visits" }),
    );
    const pageviews = labelOf(
      createElement(TimeSeriesChart, { series, metric: "pageviews" }),
    );
    expect(visits).not.toBe(pageviews);
  });

  it("drops visits from the name when the provider sent no visit series", () => {
    // `visits: null` means the figure is absent, not zero. The chart declines
    // to plot it, so the name must not promise it either.
    const label = labelOf(
      createElement(TimeSeriesChart, { series: days(30, null), metric: "both" }),
    );
    expect(label).toBe("Daily page views over the last 30 days");
  });

  it("draws nothing at all when the only requested series is missing", () => {
    // The dashboard's first chart asks for visits alone. With no per-day
    // session series the old code still drew the frame — a grid and an axis
    // running 0 to 1 — which reads as a site nobody visited rather than as a
    // figure the provider never sent.
    const markup = renderToStaticMarkup(
      createElement(TimeSeriesChart, { series: days(30, null), metric: "visits" }),
    );
    expect(markup).toBe("");
  });

  it("counts the days it actually received", () => {
    const label = labelOf(
      createElement(TimeSeriesChart, { series: days(7), metric: "pageviews" }),
    );
    expect(label).toContain("last 7 days");
  });
});

describe("two charts on one page do not share a gradient", () => {
  it("uses the id it was given", () => {
    // SVG gradient ids are document-global: two charts sharing one means the
    // second silently paints with the first one's fill.
    const markup = renderToStaticMarkup(
      createElement(TimeSeriesChart, {
        series: days(30),
        metric: "pageviews",
        gradientId: "chart-area-fade-pageviews",
      }),
    );
    expect(markup).toContain('id="chart-area-fade-pageviews"');
    expect(markup).toContain("url(#chart-area-fade-pageviews)");
  });
});

/**
 * The dates along the bottom, at the widths the chart is actually shown.
 *
 * Drawn at a fixed 720 and scaled down into the dashboard's half-width
 * columns, a phone or a client tile, the dates shrank to about 7px and
 * crowded the right-hand end. The chart now draws at its real width, so the
 * test is about spacing in real pixels.
 */
describe("the date labels", () => {
  function datePositions(width: number, count = 30): number[] {
    const markup = renderToStaticMarkup(
      createElement(TimeSeriesChart, { series: days(count), width }),
    );
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(markup)!;
    const bottom = Number(viewBox[2]) - 8;
    return [...markup.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*class="chart-tick"/g)]
      .filter((m) => Number(m[2]) === bottom)
      .map((m) => Number(m[1]));
  }

  it("draws at the width it is given, so text is not scaled down", () => {
    const markup = renderToStaticMarkup(createElement(TimeSeriesChart, { series: days(30), width: 360 }));
    expect(markup).toContain('viewBox="0 0 360 180"');
  });

  for (const width of [300, 360, 450, 720, 1100]) {
    it(`keeps every date at least 75px from the next at ${width}px`, () => {
      const xs = datePositions(width);
      expect(xs.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i]! - xs[i - 1]!, `labels ${i - 1} and ${i}`).toBeGreaterThanOrEqual(75);
      }
    });
  }

  it("shows fewer dates on a narrow chart than a wide one", () => {
    expect(datePositions(320).length).toBeLessThan(datePositions(900).length);
  });
});
