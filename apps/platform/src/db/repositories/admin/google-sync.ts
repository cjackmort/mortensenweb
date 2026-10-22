import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  googleDailyMetrics,
  googleLocations,
  googleReviews,
  googleSearchKeywords,
} from "@/db/schema";
import type { GoogleBusinessClient } from "@/lib/google-business/client";
import { googleBusinessConfigured } from "@/lib/google-business/config";
import { describeGoogleError, GoogleApiError } from "@/lib/google-business/errors";
import { keywordMonths, syncRange } from "@/lib/google-business/metrics";
import { draftReviewReply, servicesFrom, type BusinessVoice } from "@/lib/google-business/reply-draft";
import type { GoogleReview, ProfileSnapshot } from "@/lib/google-business/types";
import { getBusinessProfile } from "./business-profile";
import {
  ACCESS_PROBE_INTERVAL_MS,
  errorKindOf,
  GoogleUnavailableError,
  liveConnection,
  probeGoogleAccess,
  withGoogle,
} from "./google-connection";

/**
 * Keeping each linked profile's copy current: the profile itself, its
 * reviews, posts and photo counts every six hours, Performance figures and
 * search terms once a day.
 *
 * ## Spending Google's quota carefully
 *
 * The quota belongs to the whole project, shared by every client, so the
 * sync is built to never be the reason an operator's edit is refused:
 *
 *  - **A few locations per tick** (`LOCATIONS_PER_TICK`), oldest first, each
 *    about eight calls. A backlog drains over several ticks.
 *  - **A 429 stops the run** and pauses every caller (`withGoogle` records it),
 *    rather than letting the next location try and fail too.
 *  - **Per-location backoff.** A location that fails for its own reasons —
 *    the client removed the agency as a manager — waits longer after each
 *    consecutive failure, up to a day, instead of being retried every tick.
 *  - **Figures daily, search terms once.** Performance data only changes
 *    daily, and a past month's search terms do not change, so each month is
 *    fetched once.
 *
 * Runs from `/api/cron` inside the scheduler gate, so it adds no wake-ups of
 * its own.
 */

export const LOCATIONS_PER_TICK = 5;
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const METRICS_INTERVAL_MS = 20 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** Fifty reviews a page; two hundred is every review most small businesses have. */
const MAX_REVIEW_PAGES = 4;

export function backoffFor(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

export interface SyncableLocation {
  id: string;
  organizationId: string;
  accountName: string;
  locationName: string;
  metricsSyncedAt: Date | null;
  syncFailures: number;
}

/** What a draft reply may draw on: the business's own published details. */
export async function businessVoiceFor(
  db: Database,
  organizationId: string,
  snapshot: ProfileSnapshot | null,
): Promise<BusinessVoice> {
  const details = (await getBusinessProfile(db, organizationId))?.details ?? {};
  return {
    name: details.businessName ?? snapshot?.title ?? null,
    phone: details.phone ?? snapshot?.phone ?? null,
    email: details.email ?? null,
    services: servicesFrom(details.services),
  };
}

async function storeReviews(
  db: Database,
  location: SyncableLocation,
  reviews: GoogleReview[],
  complete: boolean,
  voice: BusinessVoice,
  now: Date,
): Promise<void> {
  for (const review of reviews) {
    const draft = review.reply
      ? null
      : draftReviewReply(
          { reviewId: review.reviewId, reviewerName: review.reviewerName, starRating: review.starRating, comment: review.comment },
          voice,
        );
    await db
      .insert(googleReviews)
      .values({
        locationId: location.id,
        organizationId: location.organizationId,
        googleReviewId: review.reviewId,
        reviewerName: review.reviewerName,
        starRating: review.starRating,
        comment: review.comment,
        postedAt: review.postedAt,
        editedAt: review.editedAt,
        replyComment: review.reply?.comment ?? null,
        repliedAt: review.reply?.updatedAt ?? null,
        draftReply: draft,
        draftSource: draft ? "portal" : null,
        draftUpdatedAt: draft ? now : null,
      })
      .onConflictDoUpdate({
        target: [googleReviews.locationId, googleReviews.googleReviewId],
        set: {
          reviewerName: review.reviewerName,
          starRating: review.starRating,
          comment: review.comment,
          postedAt: review.postedAt,
          editedAt: review.editedAt,
          replyComment: review.reply?.comment ?? null,
          repliedAt: review.reply?.updatedAt ?? null,
          removedAt: null,
          updatedAt: now,
          // Replied on Google — by us or by the owner in their own app — so
          // a waiting draft is moot. An operator's own edit to a draft is
          // otherwise never overwritten by a fresh portal draft.
          ...(review.reply
            ? { draftReply: null, draftSource: null, draftUpdatedAt: null, replyError: null }
            : {
                draftReply: sql`coalesce(${googleReviews.draftReply}, ${draft})`,
                draftSource: sql`coalesce(${googleReviews.draftSource}, 'portal')`,
                draftUpdatedAt: sql`coalesce(${googleReviews.draftUpdatedAt}, ${now.toISOString()}::timestamptz)`,
              }),
        },
      });
  }

  // Only a sync that saw every review can say which ones are gone.
  if (complete) {
    const seen = reviews.map((r) => r.reviewId);
    await db
      .update(googleReviews)
      .set({ removedAt: now, updatedAt: now })
      .where(
        and(
          eq(googleReviews.locationId, location.id),
          isNull(googleReviews.removedAt),
          seen.length > 0 ? notInArray(googleReviews.googleReviewId, seen) : undefined,
        ),
      );
  }
}

async function storeMetrics(db: Database, google: GoogleBusinessClient, location: SyncableLocation, now: Date): Promise<void> {
  const rows = await google.dailyMetrics(location.locationName, syncRange(now));
  for (const row of rows) {
    await db
      .insert(googleDailyMetrics)
      .values({ locationId: location.id, ...row })
      .onConflictDoUpdate({
        target: [googleDailyMetrics.locationId, googleDailyMetrics.date],
        set: {
          searchViews: row.searchViews,
          mapsViews: row.mapsViews,
          calls: row.calls,
          websiteClicks: row.websiteClicks,
          directionRequests: row.directionRequests,
          updatedAt: now,
        },
      });
  }

  const wanted = keywordMonths(now);
  const have = await db
    .selectDistinct({ month: googleSearchKeywords.month })
    .from(googleSearchKeywords)
    .where(and(eq(googleSearchKeywords.locationId, location.id), inArray(googleSearchKeywords.month, wanted)));
  const stored = new Set(have.map((h) => h.month));

  for (const month of wanted.filter((m) => !stored.has(m))) {
    const counts = await google.searchKeywords(location.locationName, month);
    // A month with no terms at all is still fetched once; an empty month
    // simply has no rows, and is asked again next time — cheap, and correct
    // if Google had not published it yet.
    for (const count of counts) {
      await db
        .insert(googleSearchKeywords)
        .values({ locationId: location.id, month, ...count })
        .onConflictDoNothing();
    }
  }
}

/** Sync one location. Throws `GoogleApiError` for the caller to classify. */
export async function syncLocation(
  db: Database,
  location: SyncableLocation,
  { now = new Date(), includeMetrics }: { now?: Date; includeMetrics?: boolean } = {},
): Promise<void> {
  const metricsDue =
    includeMetrics ?? (!location.metricsSyncedAt || now.getTime() - location.metricsSyncedAt.getTime() >= METRICS_INTERVAL_MS);

  await withGoogle(
    db,
    async (google) => {
      const snapshot = await google.getLocation(location.locationName);

      const reviews: GoogleReview[] = [];
      let pageToken: string | null = null;
      let pages = 0;
      let averageRating: number | null = null;
      let totalReviewCount: number | null = null;
      do {
        const page = await google.listReviews(location.accountName, location.locationName, pageToken);
        reviews.push(...page.reviews);
        averageRating = page.averageRating ?? averageRating;
        totalReviewCount = page.totalReviewCount ?? totalReviewCount;
        pageToken = page.nextPageToken;
        pages += 1;
      } while (pageToken && pages < MAX_REVIEW_PAGES);

      const [lastPostAt, photoCount] = await Promise.all([
        google.latestPostAt(location.accountName, location.locationName),
        google.photoCount(location.accountName, location.locationName),
      ]);

      const voice = await businessVoiceFor(db, location.organizationId, snapshot);
      await storeReviews(db, location, reviews, pageToken === null, voice, now);
      if (metricsDue) await storeMetrics(db, google, location, now);

      await db
        .update(googleLocations)
        .set({
          title: snapshot.title,
          snapshot,
          snapshotAt: now,
          averageRating,
          reviewCount: totalReviewCount,
          photoCount,
          lastPostAt,
          lastSyncedAt: now,
          ...(metricsDue ? { metricsSyncedAt: now } : {}),
          nextSyncAt: new Date(now.getTime() + SYNC_INTERVAL_MS),
          syncFailures: 0,
          lastSyncError: null,
          updatedAt: now,
        })
        .where(eq(googleLocations.id, location.id));
    },
    { now },
  );
}

async function recordLocationFailure(db: Database, location: SyncableLocation, error: unknown, now: Date): Promise<void> {
  const failures = location.syncFailures + 1;
  const kind = error instanceof GoogleApiError ? error.kind : "unavailable";
  await db
    .update(googleLocations)
    .set({
      syncFailures: failures,
      nextSyncAt: new Date(now.getTime() + backoffFor(failures)),
      lastSyncError: `${kind}: ${describeGoogleError(error)}`,
      updatedAt: now,
    })
    .where(eq(googleLocations.id, location.id));
}

export type GoogleSyncResult =
  | { ran: false; reason: "not_configured" | "not_connected" | "needs_reconnect" | "quota_paused"; until?: string }
  | { ran: true; synced: number; failed: number; probed: boolean; stopped: "quota" | "auth" | null };

/** The scheduled job. Never throws for Google's reasons; reports them. */
export async function runScheduledGoogleSync(
  db: Database,
  { now = new Date(), limit = LOCATIONS_PER_TICK }: { now?: Date; limit?: number } = {},
): Promise<GoogleSyncResult> {
  // The env check first: on a server without Google set up, this job costs
  // nothing at all.
  if (!googleBusinessConfigured()) return { ran: false, reason: "not_configured" };

  const connection = await liveConnection(db);
  if (!connection) return { ran: false, reason: "not_connected" };
  if (errorKindOf(connection.lastError) === "auth") return { ran: false, reason: "needs_reconnect" };
  if (connection.quotaPausedUntil && connection.quotaPausedUntil > now) {
    return { ran: false, reason: "quota_paused", until: connection.quotaPausedUntil.toISOString() };
  }

  const due = await db
    .select({
      id: googleLocations.id,
      organizationId: googleLocations.organizationId,
      accountName: googleLocations.accountName,
      locationName: googleLocations.locationName,
      metricsSyncedAt: googleLocations.metricsSyncedAt,
      syncFailures: googleLocations.syncFailures,
    })
    .from(googleLocations)
    .where(or(isNull(googleLocations.nextSyncAt), lte(googleLocations.nextSyncAt, now)))
    .orderBy(sql`${googleLocations.nextSyncAt} asc nulls first`, asc(googleLocations.id))
    .limit(limit);

  // Nothing linked yet — which is every day until Google grants API access,
  // because linking needs it. Check now and then whether it has, so the
  // operator's screen changes on its own the day it does.
  let probed = false;
  if (due.length === 0) {
    const lastTry = connection.lastErrorAt ?? connection.lastSuccessAt;
    if (connection.lastSuccessAt === null && (!lastTry || now.getTime() - lastTry.getTime() >= ACCESS_PROBE_INTERVAL_MS)) {
      await probeGoogleAccess(db);
      probed = true;
    }
    return { ran: true, synced: 0, failed: 0, probed, stopped: null };
  }

  let synced = 0;
  let failed = 0;
  for (const location of due) {
    try {
      await syncLocation(db, location, { now });
      synced += 1;
    } catch (error) {
      if (error instanceof GoogleUnavailableError) {
        return { ran: true, synced, failed, probed, stopped: "auth" };
      }
      if (error instanceof GoogleApiError && (error.kind === "quota" || error.kind === "auth" || error.kind === "api_disabled")) {
        // The project's problem, not this location's: no backoff charged to
        // it, and no point asking Google about the rest this tick.
        return { ran: true, synced, failed, probed, stopped: error.kind === "auth" ? "auth" : "quota" };
      }
      await recordLocationFailure(db, location, error, now);
      failed += 1;
      console.error("[google-sync] location failed", {
        location: location.locationName,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return { ran: true, synced, failed, probed, stopped: null };
}
