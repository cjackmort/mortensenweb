import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  googleLocations,
  googleProfileChanges,
  googleProfileRequests,
  googleReviews,
  mediaAssets,
  organizations,
  users,
} from "@/db/schema";
import { hasFeature } from "@/lib/growth/access";
import { profileChecklist, profileGaps, STALE_POST_DAYS, type ChecklistItem } from "@/lib/google-business/completeness";
import { readSnapshot } from "@/lib/google-business/normalize";
import type { GoogleInvitation, GoogleLocationSummary, ProfileSnapshot } from "@/lib/google-business/types";
import { NotFoundError, type AdminContext } from "../context";
import { getClientGrowth } from "./growth";
import { withGoogle } from "./google-connection";

/**
 * The operator's side of Google profile management: who has it, what each
 * profile looks like, and the queue of what needs doing across all of them.
 *
 * Reads only. Edits are in `google-edits.ts`; the connection and the sync in
 * `google-connection.ts` and `google-sync.ts`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GoogleClientRow {
  clientPublicId: string;
  organizationName: string;
  isDemo: boolean;
  hasFeature: boolean;
  location: {
    title: string | null;
    locationName: string;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
  } | null;
}

async function clientByPublicId(db: Database, clientPublicId: string) {
  const [row] = await db
    .select({
      id: clients.id,
      publicId: clients.publicId,
      organizationId: clients.organizationId,
      organizationName: organizations.name,
      isDemo: clients.isDemo,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

export async function clientForGoogle(_ctx: AdminContext, db: Database, clientPublicId: string) {
  return clientByPublicId(db, clientPublicId);
}

/** Every client, whether their plan includes Google profile management, and their link. */
export async function listGoogleClients(ctx: AdminContext, db: Database): Promise<GoogleClientRow[]> {
  const rows = await db
    .select({
      publicId: clients.publicId,
      organizationName: organizations.name,
      isDemo: clients.isDemo,
      title: googleLocations.title,
      locationName: googleLocations.locationName,
      lastSyncedAt: googleLocations.lastSyncedAt,
      lastSyncError: googleLocations.lastSyncError,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .leftJoin(googleLocations, eq(googleLocations.clientId, clients.id))
    .where(eq(organizations.kind, "client"))
    .orderBy(asc(organizations.name));

  const result: GoogleClientRow[] = [];
  for (const row of rows) {
    const growth = await getClientGrowth(ctx, db, row.publicId);
    result.push({
      clientPublicId: row.publicId,
      organizationName: row.organizationName,
      isDemo: row.isDemo,
      hasFeature: hasFeature(growth.access, "google-profile"),
      location: row.locationName
        ? { title: row.title, locationName: row.locationName, lastSyncedAt: row.lastSyncedAt, lastSyncError: row.lastSyncError }
        : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// One client's workspace
// ---------------------------------------------------------------------------

export interface WorkspaceReview {
  id: string;
  googleReviewId: string;
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
  postedAt: Date;
  replyComment: string | null;
  repliedAt: Date | null;
  draftReply: string | null;
  draftSource: string | null;
  replyError: string | null;
}

export interface WorkspaceChange {
  kind: string;
  summary: string;
  status: string;
  error: string | null;
  createdAt: Date;
  actorName: string | null;
}

export interface WorkspaceRequest {
  publicId: string;
  body: string;
  status: string;
  operatorNote: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface WorkspacePhoto {
  publicId: string;
  filename: string;
  title: string | null;
  width: number | null;
  height: number | null;
}

export interface GoogleWorkspace {
  client: { publicId: string; organizationId: string; organizationName: string; isDemo: boolean };
  hasFeature: boolean;
  location: {
    accountName: string;
    locationName: string;
    title: string | null;
    snapshot: ProfileSnapshot | null;
    averageRating: number | null;
    reviewCount: number | null;
    photoCount: number | null;
    lastPostAt: Date | null;
    lastSyncedAt: Date | null;
    nextSyncAt: Date | null;
    lastSyncError: string | null;
    checklist: ChecklistItem[] | null;
  } | null;
  reviews: WorkspaceReview[];
  changes: WorkspaceChange[];
  requests: WorkspaceRequest[];
  photos: WorkspacePhoto[];
}

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function getGoogleWorkspace(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<GoogleWorkspace> {
  const client = await clientByPublicId(db, clientPublicId);
  const growth = await getClientGrowth(ctx, db, clientPublicId);

  const [location] = await db.select().from(googleLocations).where(eq(googleLocations.clientId, client.id)).limit(1);

  const reviews = location
    ? await db
        .select({
          id: googleReviews.id,
          googleReviewId: googleReviews.googleReviewId,
          reviewerName: googleReviews.reviewerName,
          starRating: googleReviews.starRating,
          comment: googleReviews.comment,
          postedAt: googleReviews.postedAt,
          replyComment: googleReviews.replyComment,
          repliedAt: googleReviews.repliedAt,
          draftReply: googleReviews.draftReply,
          draftSource: googleReviews.draftSource,
          replyError: googleReviews.replyError,
        })
        .from(googleReviews)
        .where(and(eq(googleReviews.locationId, location.id), isNull(googleReviews.removedAt)))
        // Unanswered first, then newest: the top of the list is the work.
        .orderBy(sql`${googleReviews.replyComment} is null desc`, desc(googleReviews.postedAt))
        .limit(50)
    : [];

  const changes = location
    ? await db
        .select({
          kind: googleProfileChanges.kind,
          summary: googleProfileChanges.summary,
          status: googleProfileChanges.status,
          error: googleProfileChanges.error,
          createdAt: googleProfileChanges.createdAt,
          actorName: users.name,
          actorEmail: users.email,
        })
        .from(googleProfileChanges)
        .leftJoin(users, eq(users.id, googleProfileChanges.actorUserId))
        .where(eq(googleProfileChanges.locationId, location.id))
        .orderBy(desc(googleProfileChanges.createdAt))
        .limit(30)
    : [];

  const requests = await db
    .select({
      publicId: googleProfileRequests.publicId,
      body: googleProfileRequests.body,
      status: googleProfileRequests.status,
      operatorNote: googleProfileRequests.operatorNote,
      createdAt: googleProfileRequests.createdAt,
      resolvedAt: googleProfileRequests.resolvedAt,
    })
    .from(googleProfileRequests)
    .where(eq(googleProfileRequests.clientId, client.id))
    .orderBy(asc(googleProfileRequests.status), desc(googleProfileRequests.createdAt))
    .limit(20);

  const photos = await db
    .select({
      publicId: mediaAssets.publicId,
      filename: mediaAssets.originalFilename,
      title: mediaAssets.title,
      width: mediaAssets.width,
      height: mediaAssets.height,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.organizationId, client.organizationId),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
        inArray(mediaAssets.contentType, PHOTO_TYPES),
      ),
    )
    .orderBy(desc(mediaAssets.createdAt))
    .limit(60);

  const snapshot = location ? readSnapshot(location.snapshot) : null;
  const unanswered = reviews.filter((r) => r.replyComment === null).length;

  return {
    client: {
      publicId: client.publicId,
      organizationId: client.organizationId,
      organizationName: client.organizationName,
      isDemo: client.isDemo,
    },
    hasFeature: hasFeature(growth.access, "google-profile"),
    location: location
      ? {
          accountName: location.accountName,
          locationName: location.locationName,
          title: location.title,
          snapshot,
          averageRating: location.averageRating,
          reviewCount: location.reviewCount,
          photoCount: location.photoCount,
          lastPostAt: location.lastPostAt,
          lastSyncedAt: location.lastSyncedAt,
          nextSyncAt: location.nextSyncAt,
          lastSyncError: location.lastSyncError?.replace(/^[a-z_]+:\s*/, "") ?? null,
          checklist: snapshot
            ? profileChecklist({ snapshot, photoCount: location.photoCount, lastPostAt: location.lastPostAt, unansweredReviews: unanswered, now })
            : null,
        }
      : null,
    reviews,
    changes: changes.map(({ actorEmail, ...c }) => ({ ...c, actorName: c.actorName ?? actorEmail ?? null })),
    requests,
    photos,
  };
}

// ---------------------------------------------------------------------------
// Live from Google: what the agency can see, and pending manager invitations
// ---------------------------------------------------------------------------

export interface LinkableLocations {
  locations: Array<GoogleLocationSummary & { linkedTo: string | null }>;
  invitations: GoogleInvitation[];
}

/** Ten accounts is far more than an agency's personal account plus groups. */
const MAX_ACCOUNTS = 10;

export async function listLinkableLocations(_ctx: AdminContext, db: Database): Promise<LinkableLocations> {
  const { locations, invitations } = await withGoogle(db, async (google) => {
    const accounts = (await google.listAccounts()).slice(0, MAX_ACCOUNTS);
    const found: GoogleLocationSummary[] = [];
    const invites: GoogleInvitation[] = [];
    for (const account of accounts) {
      found.push(...(await google.listLocations(account.name)));
      invites.push(...(await google.listInvitations(account.name)));
    }
    return { locations: found, invitations: invites };
  });

  const linked = await db
    .select({ locationName: googleLocations.locationName, organizationName: organizations.name })
    .from(googleLocations)
    .innerJoin(organizations, eq(organizations.id, googleLocations.organizationId));
  const byName = new Map(linked.map((l) => [l.locationName, l.organizationName]));

  const unique = new Map<string, GoogleLocationSummary>();
  for (const location of locations) if (!unique.has(location.name)) unique.set(location.name, location);
  return {
    locations: [...unique.values()].map((l) => ({ ...l, linkedTo: byName.get(l.name) ?? null })),
    invitations,
  };
}

// ---------------------------------------------------------------------------
// The cross-client queue
// ---------------------------------------------------------------------------

export interface GoogleQueue {
  unansweredReviews: Array<{
    clientPublicId: string;
    organizationName: string;
    reviewerName: string | null;
    starRating: number | null;
    comment: string | null;
    postedAt: Date;
    hasDraft: boolean;
  }>;
  stalePosts: Array<{ clientPublicId: string; organizationName: string; lastPostAt: Date | null }>;
  gaps: Array<{ clientPublicId: string; organizationName: string; items: ChecklistItem[] }>;
  asks: Array<{ clientPublicId: string; organizationName: string; publicId: string; body: string; createdAt: Date }>;
  syncProblems: Array<{ clientPublicId: string; organizationName: string; error: string; nextSyncAt: Date | null }>;
  /** Linked profiles never synced yet — nothing above can be judged for them. */
  awaitingFirstSync: Array<{ clientPublicId: string; organizationName: string }>;
}

export async function getGoogleQueue(
  _ctx: AdminContext,
  db: Database,
  { now = new Date() }: { now?: Date } = {},
): Promise<GoogleQueue> {
  const unanswered = await db
    .select({
      clientPublicId: clients.publicId,
      organizationName: organizations.name,
      reviewerName: googleReviews.reviewerName,
      starRating: googleReviews.starRating,
      comment: googleReviews.comment,
      postedAt: googleReviews.postedAt,
      draftReply: googleReviews.draftReply,
    })
    .from(googleReviews)
    .innerJoin(googleLocations, eq(googleLocations.id, googleReviews.locationId))
    .innerJoin(clients, eq(clients.id, googleLocations.clientId))
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(and(isNull(googleReviews.replyComment), isNull(googleReviews.removedAt)))
    // Lowest ratings first, then oldest: an unanswered one-star is the most
    // expensive thing on this page.
    .orderBy(asc(googleReviews.starRating), asc(googleReviews.postedAt))
    .limit(100);

  const locations = await db
    .select({
      id: googleLocations.id,
      clientPublicId: clients.publicId,
      organizationName: organizations.name,
      snapshot: googleLocations.snapshot,
      photoCount: googleLocations.photoCount,
      lastPostAt: googleLocations.lastPostAt,
      lastSyncedAt: googleLocations.lastSyncedAt,
      lastSyncError: googleLocations.lastSyncError,
      nextSyncAt: googleLocations.nextSyncAt,
    })
    .from(googleLocations)
    .innerJoin(clients, eq(clients.id, googleLocations.clientId))
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .orderBy(asc(organizations.name));

  const staleBefore = new Date(now.getTime() - STALE_POST_DAYS * DAY_MS);
  const unansweredByClient = new Map<string, number>();
  for (const r of unanswered) unansweredByClient.set(r.clientPublicId, (unansweredByClient.get(r.clientPublicId) ?? 0) + 1);

  const synced = locations.filter((l) => l.lastSyncedAt !== null);

  const asks = await db
    .select({
      clientPublicId: clients.publicId,
      organizationName: organizations.name,
      publicId: googleProfileRequests.publicId,
      body: googleProfileRequests.body,
      createdAt: googleProfileRequests.createdAt,
    })
    .from(googleProfileRequests)
    .innerJoin(clients, eq(clients.id, googleProfileRequests.clientId))
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(googleProfileRequests.status, "open"))
    .orderBy(asc(googleProfileRequests.createdAt));

  return {
    unansweredReviews: unanswered.map(({ draftReply, ...r }) => ({ ...r, hasDraft: draftReply !== null })),
    stalePosts: synced
      .filter((l) => l.lastPostAt === null || l.lastPostAt < staleBefore)
      .map((l) => ({ clientPublicId: l.clientPublicId, organizationName: l.organizationName, lastPostAt: l.lastPostAt })),
    gaps: synced
      .map((l) => {
        const snapshot = readSnapshot(l.snapshot);
        if (!snapshot) return null;
        const items = profileGaps({
          snapshot,
          photoCount: l.photoCount,
          lastPostAt: l.lastPostAt,
          unansweredReviews: unansweredByClient.get(l.clientPublicId) ?? 0,
          now,
          // Reviews and posts have their own lists above.
        }).filter((item) => item.key !== "reviews" && item.key !== "post");
        return items.length > 0 ? { clientPublicId: l.clientPublicId, organizationName: l.organizationName, items } : null;
      })
      .filter((g): g is NonNullable<typeof g> => g !== null),
    asks,
    syncProblems: locations
      .filter((l) => l.lastSyncError)
      .map((l) => ({
        clientPublicId: l.clientPublicId,
        organizationName: l.organizationName,
        error: l.lastSyncError!.replace(/^[a-z_]+:\s*/, ""),
        nextSyncAt: l.nextSyncAt,
      })),
    awaitingFirstSync: locations
      .filter((l) => l.lastSyncedAt === null && !l.lastSyncError)
      .map((l) => ({ clientPublicId: l.clientPublicId, organizationName: l.organizationName })),
  };
}
