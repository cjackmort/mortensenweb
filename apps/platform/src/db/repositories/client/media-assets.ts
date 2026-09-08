import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  clients,
  mediaAssets,
  mediaDerivatives,
  mediaFolders,
  mediaUsages,
  requestAssets,
} from "@/db/schema";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  FULL_WIDTH_MIN_EDGE,
  MAX_ASSET_DESCRIPTION_LENGTH,
  MAX_ASSET_TITLE_LENGTH,
} from "@/lib/media/constants";
import { displayDimensions } from "@/lib/media/probe";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { requireOwnFolder } from "./media-folders";

/**
 * Assets in the media library, tenant-scoped.
 *
 * Every query filters on `ctx.organizationId`. There is no function here that
 * takes an asset id without also taking a context, which is what makes
 * cross-tenant reads structurally impossible rather than merely absent.
 *
 * ## What "delete" means
 *
 * Two levels, and the distinction is load-bearing:
 *
 *  - **Trash** (`deleted_at` set) hides an asset from the library and from the
 *    request picker. The bytes stay. This is what a client's Delete button
 *    does, and it is reversible from the Trash view.
 *  - **Purge** removes the objects. Nothing in the client UI reaches it; it is
 *    the sweeper's job, and it refuses anything a request still references.
 *
 * A one-step permanent delete is deliberately not offered. The cost of keeping
 * bytes a client meant to discard is storage; the cost of the other mistake is
 * the only copy of a painting.
 */

export interface AssetSummary {
  publicId: string;
  status: "uploading" | "processing" | "ready" | "failed" | "quarantined";
  title: string | null;
  description: string | null;
  originalFilename: string;
  contentType: string | null;
  byteSize: number;
  /** As a person sees them: EXIF rotation already applied. */
  width: number | null;
  height: number | null;
  hasAlpha: boolean | null;
  folderPublicId: string | null;
  folderPath: string | null;
  failureReason: string | null;
  createdAt: Date;
  /** True once the thumbnail exists, so the grid knows what it can draw. */
  hasThumbnail: boolean;
}

export interface AssetUsage {
  location: string;
  state: string;
  requestPublicId: string | null;
  requestTitle: string | null;
  lastSeenAt: Date;
}

/**
 * Shape the row the way a person reads it.
 *
 * Dimensions go through `displayDimensions` here rather than at each call site.
 * A phone photo stored landscape with orientation 6 is a portrait photo to
 * everyone who looks at it, and a library that reports 4032x3024 for an image
 * the client sees as 3024x4032 will be reported as a bug — correctly.
 */
function toSummary(row: {
  publicId: string;
  status: AssetSummary["status"];
  title: string | null;
  description: string | null;
  originalFilename: string;
  contentType: string | null;
  byteSize: number;
  width: number | null;
  height: number | null;
  hasAlpha: boolean | null;
  orientation: number | null;
  folderPublicId: string | null;
  folderPath: string | null;
  failureReason: string | null;
  createdAt: Date;
  thumbCount: number | string | null;
}): AssetSummary {
  const dims =
    row.width !== null && row.height !== null
      ? displayDimensions({
          width: row.width,
          height: row.height,
          orientation: row.orientation,
        })
      : { width: null, height: null };

  return {
    publicId: row.publicId,
    status: row.status,
    title: row.title,
    description: row.description,
    originalFilename: row.originalFilename,
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    width: dims.width,
    height: dims.height,
    hasAlpha: row.hasAlpha,
    folderPublicId: row.folderPublicId,
    folderPath: row.folderPath,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    hasThumbnail: Number(row.thumbCount ?? 0) > 0,
  };
}

const summaryColumns = {
  publicId: mediaAssets.publicId,
  status: mediaAssets.status,
  title: mediaAssets.title,
  description: mediaAssets.description,
  originalFilename: mediaAssets.originalFilename,
  contentType: mediaAssets.contentType,
  byteSize: mediaAssets.byteSize,
  width: mediaAssets.width,
  height: mediaAssets.height,
  hasAlpha: mediaAssets.hasAlpha,
  orientation: mediaAssets.orientation,
  folderPublicId: mediaFolders.publicId,
  folderPath: mediaFolders.path,
  failureReason: mediaAssets.failureReason,
  createdAt: mediaAssets.createdAt,
  thumbCount: sql<number>`(
    SELECT COUNT(*) FROM "media_derivatives" d
    WHERE d."asset_id" = ${mediaAssets.id} AND d."kind" = 'thumb'
  )`,
};

export interface ListAssetsOptions {
  /** Undefined means everywhere; null means the root specifically. */
  folderPublicId?: string | null;
  search?: string;
  /** Trash view. Default false. */
  trashed?: boolean;
  /** Only assets an agent could actually use. */
  readyOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listAssets(
  db: Database,
  ctx: TenantContext,
  options: ListAssetsOptions = {},
): Promise<AssetSummary[]> {
  const filters = [eq(mediaAssets.organizationId, ctx.organizationId)];

  filters.push(
    options.trashed
      ? sql`${mediaAssets.deletedAt} IS NOT NULL`
      : isNull(mediaAssets.deletedAt),
  );

  if (options.readyOnly) filters.push(eq(mediaAssets.status, "ready"));

  if (options.folderPublicId === null) {
    filters.push(isNull(mediaAssets.folderId));
  } else if (typeof options.folderPublicId === "string") {
    const folder = await requireOwnFolder(db, ctx, options.folderPublicId);
    filters.push(eq(mediaAssets.folderId, folder.id));
  }

  const term = options.search?.trim();
  if (term) {
    // Matched against everything a client might remember: what they named it,
    // what they said about it, and what the file was called. `%` and `_` are
    // escaped so a search for "50%" is a search and not a wildcard.
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    filters.push(
      or(
        sql`${mediaAssets.title} ILIKE ${pattern}`,
        sql`${mediaAssets.description} ILIKE ${pattern}`,
        sql`${mediaAssets.originalFilename} ILIKE ${pattern}`,
      )!,
    );
  }

  const rows = await db
    .select(summaryColumns)
    .from(mediaAssets)
    .leftJoin(mediaFolders, eq(mediaFolders.id, mediaAssets.folderId))
    .where(and(...filters))
    .orderBy(desc(mediaAssets.createdAt))
    .limit(Math.min(options.limit ?? 200, 500))
    .offset(options.offset ?? 0);

  return rows.map(toSummary);
}

export async function getAsset(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<AssetSummary> {
  const rows = await db
    .select(summaryColumns)
    .from(mediaAssets)
    .leftJoin(mediaFolders, eq(mediaFolders.id, mediaAssets.folderId))
    .where(
      and(
        eq(mediaAssets.publicId, publicId),
        eq(mediaAssets.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();
  return toSummary(row);
}

/**
 * Where this image is used.
 *
 * Sourced from `media_usages`, which the request pipeline writes — never from
 * scanning the published site. The UI says as much beside it, because a client
 * seeing "not used anywhere" for a photo that is plainly on their home page
 * would reasonably conclude the feature is broken.
 */
export async function getAssetUsage(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<AssetUsage[]> {
  const rows = await db
    .select({
      location: mediaUsages.location,
      state: mediaUsages.state,
      requestPublicId: changeRequests.publicId,
      requestTitle: changeRequests.title,
      lastSeenAt: mediaUsages.lastSeenAt,
    })
    .from(mediaUsages)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaUsages.assetId))
    .leftJoin(changeRequests, eq(changeRequests.id, mediaUsages.requestId))
    .where(
      and(
        eq(mediaAssets.publicId, publicId),
        eq(mediaAssets.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(desc(mediaUsages.lastSeenAt));

  return rows;
}

export type AssetMutation = { ok: boolean; message: string };

export async function updateAssetDetails(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  input: { title?: string; description?: string },
): Promise<AssetMutation> {
  assertMutable(ctx);

  const title = input.title?.trim() ?? "";
  const description = input.description?.trim() ?? "";

  if (title.length > MAX_ASSET_TITLE_LENGTH) {
    return { ok: false, message: `Titles are limited to ${MAX_ASSET_TITLE_LENGTH} characters.` };
  }
  if (description.length > MAX_ASSET_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      message: `Descriptions are limited to ${MAX_ASSET_DESCRIPTION_LENGTH} characters.`,
    };
  }

  const updated = await db
    .update(mediaAssets)
    .set({
      title: title || null,
      description: description || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mediaAssets.publicId, publicId),
        eq(mediaAssets.organizationId, ctx.organizationId),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .returning({ id: mediaAssets.id });

  if (updated.length === 0) return { ok: false, message: "We couldn't find that image." };
  return { ok: true, message: "Saved." };
}

/**
 * Move images between folders.
 *
 * This changes where an image is *filed* and nothing else. It does not touch
 * the site, does not queue a change request, and does not alter any request
 * already dispatched — those carry a snapshot taken at dispatch precisely so
 * that tidying the library later cannot rewrite what an agent was asked to do.
 */
export async function moveAssets(
  db: Database,
  ctx: TenantContext,
  publicIds: string[],
  folderPublicId: string | null,
): Promise<AssetMutation> {
  assertMutable(ctx);
  if (publicIds.length === 0) return { ok: false, message: "Nothing was selected." };

  let folderId: string | null = null;
  if (folderPublicId) {
    try {
      folderId = (await requireOwnFolder(db, ctx, folderPublicId)).id;
    } catch {
      return { ok: false, message: "We couldn't find that folder." };
    }
  }

  const moved = await db
    .update(mediaAssets)
    .set({ folderId, updatedAt: new Date() })
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        isNull(mediaAssets.deletedAt),
        inArray(mediaAssets.publicId, publicIds),
      ),
    )
    .returning({ id: mediaAssets.id });

  if (moved.length === 0) return { ok: false, message: "We couldn't find those images." };
  return {
    ok: true,
    message:
      moved.length === 1 ? "Image moved." : `${moved.length} images moved.`,
  };
}

/**
 * Move images to the trash.
 *
 * Refuses outright for anything a request references, and names the request.
 * The alternative — trashing it and letting the agent find a missing file
 * later — turns a clear refusal now into a failed build with an opaque cause.
 */
export async function trashAssets(
  db: Database,
  ctx: TenantContext,
  publicIds: string[],
): Promise<AssetMutation & { blocked: string[] }> {
  assertMutable(ctx);
  if (publicIds.length === 0) {
    return { ok: false, message: "Nothing was selected.", blocked: [] };
  }

  const referenced = await db
    .select({
      assetPublicId: mediaAssets.publicId,
      assetName: mediaAssets.originalFilename,
      assetTitle: mediaAssets.title,
      requestTitle: changeRequests.title,
      requestStatus: changeRequests.status,
    })
    .from(requestAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.id, requestAssets.assetId))
    .innerJoin(changeRequests, eq(changeRequests.id, requestAssets.requestId))
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        inArray(mediaAssets.publicId, publicIds),
        // A closed request no longer needs its inputs held. An open one does.
        sql`${changeRequests.status} NOT IN ('closed', 'rejected', 'rolled_back')`,
      ),
    );

  const blockedIds = new Set(referenced.map((r) => r.assetPublicId));
  const removable = publicIds.filter((id) => !blockedIds.has(id));

  if (removable.length === 0) {
    const first = referenced[0];
    return {
      ok: false,
      blocked: [...blockedIds],
      message: first
        ? `"${first.assetTitle ?? first.assetName}" is being used by your request "${first.requestTitle}", so it can't be deleted yet. It will be free once that change is finished.`
        : "Those images are in use by a change request.",
    };
  }

  const trashed = await db
    .update(mediaAssets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        isNull(mediaAssets.deletedAt),
        inArray(mediaAssets.publicId, removable),
      ),
    )
    .returning({ id: mediaAssets.id });

  const kept = blockedIds.size;
  return {
    ok: trashed.length > 0,
    blocked: [...blockedIds],
    message:
      kept === 0
        ? trashed.length === 1
          ? "Moved to trash."
          : `${trashed.length} images moved to trash.`
        : `${trashed.length} moved to trash. ${kept} kept, because a change request is still using them.`,
  };
}

export async function restoreAssets(
  db: Database,
  ctx: TenantContext,
  publicIds: string[],
): Promise<AssetMutation> {
  assertMutable(ctx);
  if (publicIds.length === 0) return { ok: false, message: "Nothing was selected." };

  const restored = await db
    .update(mediaAssets)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        inArray(mediaAssets.publicId, publicIds),
      ),
    )
    .returning({ id: mediaAssets.id });

  if (restored.length === 0) return { ok: false, message: "We couldn't find those images." };
  return {
    ok: true,
    message: restored.length === 1 ? "Restored." : `${restored.length} images restored.`,
  };
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

export interface FolderSelection {
  folderPath: string;
  assets: AssetSummary[];
  /** In the folder but not usable yet, so the client is not surprised later. */
  skippedNotReady: number;
}

/**
 * Everything ready in a folder, for "attach this whole folder".
 *
 * Returns the list rather than performing the attachment, because the UI has to
 * *show* the client what they are about to attach before they commit to it.
 * "Attach folder" that silently resolves to a set nobody saw is how a client
 * sends twelve images meaning to send three.
 *
 * Assets still processing are counted and reported, never silently dropped and
 * never waited for.
 */
export async function selectFolderContents(
  db: Database,
  ctx: TenantContext,
  folderPublicId: string,
): Promise<FolderSelection> {
  const folder = await requireOwnFolder(db, ctx, folderPublicId);

  const all = await db
    .select({ status: mediaAssets.status })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        eq(mediaAssets.folderId, folder.id),
        isNull(mediaAssets.deletedAt),
      ),
    );

  const assets = await listAssets(db, ctx, {
    folderPublicId,
    readyOnly: true,
    limit: 500,
  });

  return {
    folderPath: folder.path,
    assets,
    skippedNotReady: all.filter((row) => row.status !== "ready").length,
  };
}

/**
 * Whether an image is big enough for what it is about to be used for.
 *
 * A warning and never a refusal, and explicitly never an upscale. Enlarging
 * pixels that were never captured produces a soft image that looks like our
 * mistake, so the number is put in front of the client and the decision stays
 * theirs.
 */
export function resolutionWarning(
  asset: Pick<AssetSummary, "width" | "height">,
  minEdge: number = FULL_WIDTH_MIN_EDGE,
): string | null {
  if (asset.width === null || asset.height === null) return null;
  const longest = Math.max(asset.width, asset.height);
  if (longest >= minEdge) return null;
  return `This image is ${asset.width}x${asset.height}. Below about ${minEdge}px on the long edge it will look soft used full width — it is fine smaller, or beside text.`;
}

// ---------------------------------------------------------------------------
// Storage accounting
// ---------------------------------------------------------------------------

export interface StorageUsage {
  originalBytes: number;
  derivativeBytes: number;
  totalBytes: number;
  quotaBytes: number;
  /** Trashed assets still occupy storage, and saying so avoids a support call. */
  trashedBytes: number;
  assetCount: number;
  percentUsed: number;
}

/**
 * What this client is storing, and what they are allowed.
 *
 * Derivatives are counted separately because they are ours, not theirs — a
 * client asking why 200 MB of photos reads as 260 MB deserves an answer, and
 * "your originals plus the sizes we generated for your site" is one.
 */
export async function getStorageUsage(
  db: Database,
  ctx: TenantContext,
): Promise<StorageUsage> {
  const totals = await db
    .select({
      originalBytes: sql<string>`COALESCE(SUM(${mediaAssets.byteSize}) FILTER (WHERE ${mediaAssets.deletedAt} IS NULL), 0)`,
      trashedBytes: sql<string>`COALESCE(SUM(${mediaAssets.byteSize}) FILTER (WHERE ${mediaAssets.deletedAt} IS NOT NULL), 0)`,
      assetCount: sql<string>`COUNT(*) FILTER (WHERE ${mediaAssets.deletedAt} IS NULL)`,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.organizationId, ctx.organizationId));

  const derivatives = await db
    .select({
      bytes: sql<string>`COALESCE(SUM(${mediaDerivatives.byteSize}), 0)`,
    })
    .from(mediaDerivatives)
    .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
    .where(eq(mediaAssets.organizationId, ctx.organizationId));

  const quotaRow = await db
    .select({ quota: clients.mediaQuotaBytes })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const originalBytes = Number(totals[0]?.originalBytes ?? 0);
  const trashedBytes = Number(totals[0]?.trashedBytes ?? 0);
  const derivativeBytes = Number(derivatives[0]?.bytes ?? 0);
  const quotaBytes = Number(quotaRow[0]?.quota ?? DEFAULT_STORAGE_QUOTA_BYTES);
  // Trash counts against the quota. It occupies real storage, and a quota that
  // ignored it would let someone exceed it without any screen saying so.
  const totalBytes = originalBytes + trashedBytes + derivativeBytes;

  return {
    originalBytes,
    derivativeBytes,
    trashedBytes,
    totalBytes,
    quotaBytes,
    assetCount: Number(totals[0]?.assetCount ?? 0),
    percentUsed: quotaBytes > 0 ? Math.min(100, (totalBytes / quotaBytes) * 100) : 0,
  };
}

/** Folder options for a picker, cheapest possible query. */
export async function listFolderOptions(
  db: Database,
  ctx: TenantContext,
): Promise<{ publicId: string; path: string; name: string }[]> {
  return db
    .select({
      publicId: mediaFolders.publicId,
      path: mediaFolders.path,
      name: mediaFolders.name,
    })
    .from(mediaFolders)
    .where(
      and(
        eq(mediaFolders.organizationId, ctx.organizationId),
        isNull(mediaFolders.deletedAt),
      ),
    )
    .orderBy(asc(mediaFolders.path));
}
