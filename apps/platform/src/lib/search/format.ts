import type { SearchDay, SearchRow } from "@/lib/connections/providers/google";

/**
 * The Search card's words and numbers, kept pure so they can be pinned.
 *
 * What the client reads is "you showed up 1,240 times, average position
 * 4.2", not a row of raw floats. Google reports position as a mean of
 * rankings (4.2 is real, 4.23517 is noise) and click rate as a fraction, so
 * every figure is rounded here, once, the same way on the card, in the table
 * and in the headline.
 */

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "1,240" */
export function formatCount(value: number): string {
  return count.format(Math.round(value));
}

/** "4.2"; "–" when Google reported nothing to average. */
export function formatPosition(position: number): string {
  if (!Number.isFinite(position) || position <= 0) return "–";
  return position.toFixed(1);
}

/** "3.0%" from a fraction. */
export function formatRate(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < 0) return "–";
  return `${(fraction * 100).toFixed(1)}%`;
}

export interface SearchTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** "You showed up 1,240 times, average position 4.2" — or what is true when nothing was shown. */
export function searchHeadline(totals: SearchTotals): string {
  if (totals.impressions <= 0) return "Google did not show your site in the last 28 days";
  const times = totals.impressions === 1 ? "once" : `${formatCount(totals.impressions)} times`;
  const position = totals.position > 0 ? `, average position ${formatPosition(totals.position)}` : "";
  return `You showed up ${times}${position}`;
}

/**
 * Every day of the window as a series, with the days Google left out filled
 * with zero, so a sparkline of 28 points is 28 points wide and a quiet day is
 * drawn as quiet rather than skipped.
 */
export function dailySeries(
  daily: SearchDay[] | undefined,
  window: { startDate: string; endDate: string },
  pick: (day: SearchDay) => number,
): number[] {
  const byDate = new Map((daily ?? []).map((d) => [d.date, d]));
  const out: number[] = [];
  for (const date of eachDay(window.startDate, window.endDate)) {
    const day = byDate.get(date);
    out.push(day ? pick(day) : 0);
  }
  return out;
}

function* eachDay(start: string, end: string): Generator<string> {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  for (let t = from; t <= to; t += 24 * 60 * 60 * 1000) yield new Date(t).toISOString().slice(0, 10);
}

/** Position, averaged over the days that had impressions: a day with none has no rank to average. */
export function averagePosition(daily: SearchDay[] | undefined): number {
  const shown = (daily ?? []).filter((d) => d.impressions > 0 && d.position > 0);
  if (shown.length === 0) return 0;
  const weighted = shown.reduce((sum, d) => sum + d.position * d.impressions, 0);
  const impressions = shown.reduce((sum, d) => sum + d.impressions, 0);
  return weighted / impressions;
}

/** Queries as the table shows them: most shown first, ties by clicks. */
export function rankQueries(queries: SearchRow[]): SearchRow[] {
  return [...queries].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.key.localeCompare(b.key));
}

/** "Oct 1 – Oct 28" for the window's dates, given as YYYY-MM-DD. */
export function formatWindow(startDate: string, endDate: string): string {
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day(startDate)} – ${day(endDate)}`;
}
