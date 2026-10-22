import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  googleConnections,
  googleDailyMetrics,
  googleLocations,
  googleProfileRequests,
  googleReviews,
  googleSearchKeywords,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { profileChecklist, type ChecklistItem } from "@/lib/google-business/completeness";
import {
  addDays,
  METRICS_HISTORY_DAYS,
  monthsForWindow,
  summarise,
  summariseSearches,
  type MetricsSummary,
  type MetricWindow,
  type SearchSummary,
} from "@/lib/google-business/metrics";
import { readSnapshot } from "@/lib/google-business/normalize";
import type { ProfileSnapshot } from "@/lib/google-business/types";
import { assertMutable, type TenantContext } from "../context";
import { requireGrowthFeature } from "./growth";

/**
 * Google profile management, from the client's side: what their profile
 * says, how it is doing, and a way to ask for a change. Read-only apart from
 * the ask — every edit on the profile is the operator's.
 *
 * Everything comes from the portal's own copy, synced every six hours, never
 * from a live call: a client opening a page must not spend the project's
 * Google quota, and the copy is honest about its age.
 *
 * Tenant-scoped like every client repository: each query filters on
 * `ctx.organizationId`.
 */

export type ReviewReplyState = "replied" | "drafting" | "waiting";

export interface ClientReview {
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
  postedAt: Date;
  replyState: ReviewReplyState;
  replyComment: string | null;
}

export interface ClientGoogleRequest {
  publicId: string;
  body: string;
  status: string;
  operatorNote: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export type ClientGoogleView =
  | {
      state: "not_linked";
      /** The address to add as a Manager, when the agency's account is connected. */
      agencyEmail: string | null;
      requests: ClientGoogleRequest[];
    }
  | {
      state: "linked";
      /** Linked, but the first sync has not finished: no copy of the profile yet. */
      synced: boolean;
      lastSyncedAt: Date | null;
      snapshot: ProfileSnapshot | null;
      averageRating: number | null;
      reviewCount: number | null;
      checklist: ChecklistItem[] | null;
      reviews: ClientReview[];
      unanswered: number;
      metrics: MetricsSummary;
      searches: SearchSummary | null;
      requests: ClientGoogleRequest[];
    };

async function locationFor(db: Database, ctx: TenantContext) {
  const [row] = await db
    .select()
    .from(googleLocations)
    .where(eq(googleLocations.organizationId, ctx.organizationId))
    .limit(1);
  return row ?? null;
}

async function requestsFor(db: Database, ctx: TenantContext): Promise<ClientGoogleRequest[]> {
  return db
    .select({
      publicId: googleProfileRequests.publicId,
      body: googleProfileRequests.body,
      status: googleProfileRequests.status,
      operatorNote: googleProfileRequests.operatorNote,
      createdAt: googleProfileRequests.createdAt,
      resolvedAt: googleProfileRequests.resolvedAt,
    })
    .from(googleProfileRequests)
    .where(eq(googleProfileRequests.organizationId, ctx.organizationId))
    .orderBy(desc(googleProfileRequests.createdAt))
    .limit(10);
}

export async function getGoogleProfileView(
  db: Database,
  ctx: TenantContext,
  { window = 30, now = new Date() }: { window?: MetricWindow; now?: Date } = {},
): Promise<ClientGoogleView> {
  const [location, requests] = await Promise.all([locationFor(db, ctx), requestsFor(db, ctx)]);

  if (!location) {
    const [connection] = await db
      .select({ email: googleConnections.googleEmail })
      .from(googleConnections)
      .where(isNull(googleConnections.revokedAt))
      .limit(1);
    return { state: "not_linked", agencyEmail: connection?.email ?? null, requests };
  }

  const reviewRows = await db
    .select({
      reviewerName: googleReviews.reviewerName,
      starRating: googleReviews.starRating,
      comment: googleReviews.comment,
      postedAt: googleReviews.postedAt,
      replyComment: googleReviews.replyComment,
      draftReply: googleReviews.draftReply,
    })
    .from(googleReviews)
    .where(and(eq(googleReviews.locationId, location.id), eq(googleReviews.organizationId, ctx.organizationId), isNull(googleReviews.removedAt)))
    .orderBy(desc(googleReviews.postedAt));

  const reviews: ClientReview[] = reviewRows.map((r) => ({
    reviewerName: r.reviewerName,
    starRating: r.starRating,
    comment: r.comment,
    postedAt: r.postedAt,
    replyComment: r.replyComment,
    // A portal draft waiting for the operator reads to the client as "we
    // are on it", which it is; nothing about the draft itself is shown.
    replyState: r.replyComment ? "replied" : r.draftReply ? "drafting" : "waiting",
  }));
  const unanswered = reviews.filter((r) => r.replyState !== "replied").length;

  const since = addDays(now.toISOString().slice(0, 10), -METRICS_HISTORY_DAYS);
  const metricRows = await db
    .select({
      date: googleDailyMetrics.date,
      searchViews: googleDailyMetrics.searchViews,
      mapsViews: googleDailyMetrics.mapsViews,
      calls: googleDailyMetrics.calls,
      websiteClicks: googleDailyMetrics.websiteClicks,
      directionRequests: googleDailyMetrics.directionRequests,
    })
    .from(googleDailyMetrics)
    .where(and(eq(googleDailyMetrics.locationId, location.id), gte(googleDailyMetrics.date, since)))
    .orderBy(asc(googleDailyMetrics.date));

  const keywordRows = await db
    .select({
      month: googleSearchKeywords.month,
      keyword: googleSearchKeywords.keyword,
      impressions: googleSearchKeywords.impressions,
      belowThreshold: googleSearchKeywords.belowThreshold,
    })
    .from(googleSearchKeywords)
    .where(eq(googleSearchKeywords.locationId, location.id));

  const snapshot = readSnapshot(location.snapshot);

  return {
    state: "linked",
    synced: location.lastSyncedAt !== null,
    lastSyncedAt: location.lastSyncedAt,
    snapshot,
    averageRating: location.averageRating,
    reviewCount: location.reviewCount,
    checklist:
      snapshot && location.lastSyncedAt
        ? profileChecklist({ snapshot, photoCount: location.photoCount, lastPostAt: location.lastPostAt, unansweredReviews: unanswered, now })
        : null,
    reviews: reviews.slice(0, 10),
    unanswered,
    metrics: summarise(metricRows, window),
    searches: summariseSearches(keywordRows, monthsForWindow(keywordRows.map((k) => k.month), window)),
    requests,
  };
}

// ---------------------------------------------------------------------------
// Asking for a change
// ---------------------------------------------------------------------------

export const ASK_MIN = 5;
export const ASK_MAX = 2000;
/** Open asks one client can have waiting at once; more is a sign of a loop, not a need. */
export const MAX_OPEN_ASKS = 10;

export type AskResult = { ok: true; message: string } | { ok: false; message: string };

export async function askForGoogleChange(db: Database, ctx: TenantContext, raw: string): Promise<AskResult> {
  assertMutable(ctx);
  if (!(await requireGrowthFeature(db, ctx, "google-profile"))) {
    return { ok: false, message: "Your plan does not include Google profile management. See Growth to add it." };
  }
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body.length < ASK_MIN) return { ok: false, message: "Say what you would like changed." };
  if (body.length > ASK_MAX) return { ok: false, message: `Keep it under ${ASK_MAX} characters.` };

  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  if (!client) return { ok: false, message: "Your account is not set up yet. Please contact us." };

  const open = await db
    .select({ id: googleProfileRequests.id })
    .from(googleProfileRequests)
    .where(and(eq(googleProfileRequests.organizationId, ctx.organizationId), eq(googleProfileRequests.status, "open")))
    .limit(MAX_OPEN_ASKS);
  if (open.length >= MAX_OPEN_ASKS) {
    return { ok: false, message: "You have several changes waiting already. We will get to those first." };
  }

  await db.insert(googleProfileRequests).values({
    publicId: newPublicId(),
    organizationId: ctx.organizationId,
    clientId: client.id,
    requestedBy: ctx.userId,
    body,
  });
  return { ok: true, message: "Sent. We will make the change on Google and mark it done here." };
}

// ---------------------------------------------------------------------------
// For other features
// ---------------------------------------------------------------------------

/**
 * Google's own "write a review" link for the caller's profile — what Review
 * requests sends customers to (`getReviewDestination`, which also checks it).
 * Null when no profile is linked yet, or the first sync has not read it.
 */
export async function getGoogleReviewLink(db: Database, ctx: TenantContext): Promise<{ url: string } | null> {
  const location = await locationFor(db, ctx);
  const url = readSnapshot(location?.snapshot)?.reviewUrl;
  return url ? { url } : null;
}

/**
 * The profile's rating and review count, in the shape Review requests'
 * `ReviewStatsSource` returns (`lib/reviews/stats.ts`), which prefers this
 * over the Places API for a client with a linked profile.
 */
export async function getGoogleReviewStats(
  db: Database,
  ctx: TenantContext,
): Promise<
  | { ok: true; stats: { rating: number | null; reviewCount: number | null; source: "Google Business Profile" } }
  | { ok: false; reason: "unavailable" }
> {
  const location = await locationFor(db, ctx);
  if (!location?.lastSyncedAt) return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    stats: { rating: location.averageRating, reviewCount: location.reviewCount, source: "Google Business Profile" },
  };
}
