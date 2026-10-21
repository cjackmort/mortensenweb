import { and, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { googleDailyMetrics, googleLocations, googleReviews } from "@/db/schema";
import { formatDate } from "@/lib/time";
import type { ExtensionSection, ReportExtension } from "./extensions";
import type { ReportWindow } from "./period";
import { plural } from "./wording";

/**
 * The monthly report's Google profile section: what the business's Business
 * Profile did in the month — views, calls, website clicks, direction requests
 * and new reviews — from the portal's synced copy (`google_daily_metrics`,
 * `google_reviews`), never a live call to Google.
 *
 * It reports only what Google actually reported:
 *
 *  - **No profile linked, or no figures from Google yet**: `missing`, saying
 *    which. Every profile is in the second state while Google has not
 *    approved the portal's Business Profile API access.
 *  - **Daily figures** sum the days Google sent. Google runs a few days
 *    behind, so a month it has only partly reported says how many of its
 *    days the figures cover rather than passing for the whole month.
 *  - **New reviews** are counted only from a copy refreshed during or after
 *    the month. A copy last refreshed before the month began cannot say
 *    nobody left a review in it.
 */

const fmt = (n: number) => n.toLocaleString("en-US");

interface DailyFigures {
  days: number;
  views: number;
  calls: number;
  websiteClicks: number;
  directionRequests: number;
}

async function dailyFigures(db: Database, locationId: string, window: ReportWindow): Promise<DailyFigures> {
  const m = googleDailyMetrics;
  const [row] = await db
    .select({
      days: sql<number>`count(*)::int`,
      views: sql<number>`coalesce(sum(${m.searchViews} + ${m.mapsViews}), 0)::int`,
      calls: sql<number>`coalesce(sum(${m.calls}), 0)::int`,
      websiteClicks: sql<number>`coalesce(sum(${m.websiteClicks}), 0)::int`,
      directionRequests: sql<number>`coalesce(sum(${m.directionRequests}), 0)::int`,
    })
    .from(m)
    .where(and(eq(m.locationId, locationId), gte(m.date, window.firstDay), lte(m.date, window.lastDay)));
  return {
    days: Number(row?.days ?? 0),
    views: Number(row?.views ?? 0),
    calls: Number(row?.calls ?? 0),
    websiteClicks: Number(row?.websiteClicks ?? 0),
    directionRequests: Number(row?.directionRequests ?? 0),
  };
}

async function newReviewCount(
  db: Database,
  organizationId: string,
  locationId: string,
  window: ReportWindow,
): Promise<number> {
  const r = googleReviews;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(r)
    .where(
      and(
        eq(r.organizationId, organizationId),
        eq(r.locationId, locationId),
        // Gone from Google since: its author deleted it, or Google removed it.
        isNull(r.removedAt),
        gte(r.postedAt, window.startAt),
        lt(r.postedAt, window.endAt),
      ),
    );
  return Number(row?.n ?? 0);
}

function missing(note: string): ExtensionSection {
  return { state: "missing", headline: null, rows: [], note };
}

function section(
  window: ReportWindow,
  figures: DailyFigures,
  newReviews: number | null,
  lastSyncedAt: Date | null,
): ExtensionSection {
  const rows: ExtensionSection["rows"] = [];
  const notes: string[] = [];
  const daysInMonth = Number(window.lastDay.slice(8, 10));

  if (figures.days > 0) {
    rows.push(
      { label: "Profile views", value: fmt(figures.views) },
      { label: "Calls", value: fmt(figures.calls) },
      { label: "Website clicks", value: fmt(figures.websiteClicks) },
      { label: "Direction requests", value: fmt(figures.directionRequests) },
    );
    if (figures.days < daysInMonth) {
      notes.push(
        `Views, calls and clicks cover ${figures.days} of ${window.monthName}'s ${daysInMonth} days; Google had not reported the rest.`,
      );
    }
  } else {
    notes.push(`Google didn't report views, calls or clicks for ${window.monthName}.`);
  }

  if (newReviews !== null) {
    rows.push({ label: "New reviews", value: fmt(newReviews) });
    if (lastSyncedAt && lastSyncedAt < window.endAt) notes.push(`Reviews counted to ${formatDate(lastSyncedAt)}.`);
  } else if (lastSyncedAt) {
    notes.push(`Reviews weren't counted: the last update from Google was ${formatDate(lastSyncedAt)}.`);
  }

  return {
    state: "ok",
    headline:
      figures.days > 0
        ? plural(figures.views, "Google profile view", "Google profile views")
        : plural(newReviews ?? 0, "new Google review", "new Google reviews"),
    rows,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

export const googleProfileReport: ReportExtension = {
  key: "google-profile",
  title: "Google profile",
  feature: "google-profile",
  async build({ db, organizationId, window }) {
    const [location] = await db
      .select({ id: googleLocations.id, lastSyncedAt: googleLocations.lastSyncedAt })
      .from(googleLocations)
      .where(eq(googleLocations.organizationId, organizationId))
      .limit(1);
    if (!location) {
      return missing(`Your Google profile isn't linked to the portal yet, so there are no Google figures for ${window.monthName}.`);
    }

    const { lastSyncedAt } = location;
    const reviewsKnown = lastSyncedAt !== null && lastSyncedAt >= window.startAt;
    const [figures, newReviews] = await Promise.all([
      dailyFigures(db, location.id, window),
      reviewsKnown ? newReviewCount(db, organizationId, location.id, window) : Promise.resolve(null),
    ]);

    if (figures.days === 0 && newReviews === null) {
      return missing(
        lastSyncedAt === null
          ? "Your Google profile is linked, but Google hasn't sent us its figures yet."
          : `Google hasn't sent figures for ${window.monthName}. The last update was ${formatDate(lastSyncedAt)}.`,
      );
    }
    return section(window, figures, newReviews, lastSyncedAt);
  },
};
