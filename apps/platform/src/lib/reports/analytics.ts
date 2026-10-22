import { classifyEvent, isPortalEvent } from "@/lib/analytics/events";
import { percentChange } from "@/lib/analytics/metrics";
import {
  fetchAnalytics,
  isUmamiConfigured,
  statValue,
  umamiFetch,
  type Breakdown,
} from "@/lib/analytics/umami";
import type { ReportWindow } from "./period";
import {
  CONTACT_EVENTS,
  missingSection,
  type ContactEvent,
  type ContactSection,
  type MissingReason,
  type VisitorsSection,
} from "./types";

/**
 * One site's month, from Umami: visitors with the trend, top pages and
 * sources, and the taps on its contact links.
 *
 * Three calls beyond `fetchAnalytics`, each allowed to fail on its own:
 *
 *  - **last month's visitors**, for the trend. `fetchAnalytics` compares with
 *    the equal-length window before, which for September is 2 August to
 *    1 September; a client reading "up 18% on August" means the calendar
 *    month. Losing it loses the arrow, never the figure.
 *  - **a year of events**, to know which contact links the site tracks. A
 *    month with no `called` events is either nobody tapping the number or a
 *    site whose number is not tagged; only the history tells them apart, and
 *    they must be reported differently.
 */

const TOP_ROWS = 5;
const HISTORY_MS = 365 * 24 * 60 * 60 * 1000;

type UmamiStatField = number | { value?: number } | undefined;
type UmamiMetric = { x: string | null; y: number };

export interface MonthAnalytics {
  visitors: VisitorsSection;
  contact: ContactSection;
}

function bothMissing(reason: MissingReason): MonthAnalytics {
  return { visitors: missingSection(reason), contact: missingSection(reason) };
}

function contactCounts(rows: { label: string; value: number }[]): Map<ContactEvent, number> {
  const counts = new Map<ContactEvent, number>();
  for (const row of rows) {
    if (isPortalEvent(row.label)) continue;
    const event = classifyEvent(row.label, row.value);
    const id = event.id as ContactEvent | null;
    if (!id || !CONTACT_EVENTS.includes(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + event.count);
  }
  return counts;
}

async function visitorsIn(websiteId: string, window: ReportWindow): Promise<number> {
  const stats = await umamiFetch<{ visitors?: UmamiStatField }>(`/websites/${websiteId}/stats`, {
    startAt: window.startAt.getTime(),
    endAt: window.endAt.getTime(),
  });
  return statValue(stats.visitors);
}

/** Which contact links the site has reported at least once in the past year. */
async function trackedContactEvents(websiteId: string, window: ReportWindow): Promise<Set<ContactEvent>> {
  const rows = await umamiFetch<UmamiMetric[]>(`/websites/${websiteId}/metrics`, {
    startAt: window.endAt.getTime() - HISTORY_MS,
    endAt: window.endAt.getTime(),
    type: "event",
    limit: 500,
  });
  const counts = contactCounts(rows.map((row) => ({ label: row.x ?? "", value: row.y })));
  return new Set([...counts].filter(([, n]) => n > 0).map(([id]) => id));
}

function top(rows: Breakdown[]): Breakdown[] {
  return rows.slice(0, TOP_ROWS).map((row) => ({ label: row.label, value: row.value }));
}

export async function monthAnalytics(
  websiteId: string | null,
  window: ReportWindow,
  previous: ReportWindow,
): Promise<MonthAnalytics> {
  if (!isUmamiConfigured()) return bothMissing("analytics_not_configured");
  if (!websiteId) return bothMissing("analytics_not_connected");

  const [state, previousVisitors, tracked] = await Promise.all([
    fetchAnalytics(websiteId, {
      range: "custom",
      customStart: window.firstDay,
      customEnd: window.lastDay,
      compare: false,
    }),
    visitorsIn(websiteId, previous).catch(() => null),
    trackedContactEvents(websiteId, window).catch(() => null),
  ]);

  if (state.kind !== "ok") {
    // fetchAnalytics re-checks configuration; anything else is the provider.
    return bothMissing(state.kind === "not_configured" ? "analytics_not_configured" : "analytics_error");
  }

  const data = state.data;
  const visitors: VisitorsSection = {
    state: "ok",
    visitors: data.visitors,
    pageviews: data.pageviews,
    previousVisitors,
    change: percentChange(data.visitors, previousVisitors),
    topPages: top(data.topPages),
    sources: top(data.referrers),
  };

  const thisMonth = contactCounts(data.events);
  const rows = CONTACT_EVENTS.filter((id) => (thisMonth.get(id) ?? 0) > 0 || tracked?.has(id)).map((id) => ({
    id,
    count: thisMonth.get(id) ?? 0,
  }));

  let contact: ContactSection;
  if (rows.length > 0) contact = { state: "ok", rows };
  // Nothing this month, and the history could not be read: we cannot say
  // whether that is a quiet month or an untagged site, so we say neither.
  else if (tracked === null) contact = missingSection("failed");
  else contact = missingSection("not_tracked");

  return { visitors, contact };
}
