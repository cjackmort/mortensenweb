import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  mediaAssets,
  mediaFolders,
  mediaUsages,
  requestAssets,
} from "@/db/schema";
import { MAX_ASSETS_PER_REQUEST } from "@/lib/media/constants";
import { displayDimensions } from "@/lib/media/probe";
import { type TenantContext } from "../context";

/**
 * Linking library images to a change request.
 *
 * ## Why identifiers instead of bytes
 *
 * A request now carries asset ids and nothing else. The images were uploaded
 * separately, minutes or weeks earlier, and are already in storage — so the
 * submission is a few hundred bytes of text whatever the client attached. That
 * removes the failure this whole change exists to remove: a request body large
 * enough for the platform to reject before any of our code sees it, taking
 * everything the client typed with it.
 *
 * ## Why the snapshot
 *
 * At dispatch, each link records what the asset looked like *then* — checksum,
 * title, description, dimensions, folder. The agent is told those values.
 *
 * Without this, a client who tidies their library after sending a request
 * changes what the agent was asked to do, silently and after the fact. Renaming
 * "photo_4823.jpg" to "hero" is a reasonable thing to do at any time; it must
 * not change the meaning of a job already in flight.
 */

export interface RequestAssetView {
  assetPublicId: string;
  position: number;
  /** What the client called it when they sent it, or its filename. */
  title: string | null;
  description: string | null;
  folderPath: string | null;
  width: number | null;
  height: number | null;
  filename: string;
  status: string;
  /** True once dispatch froze this row. */
  snapshotted: boolean;
}

export type AttachResult =
  | { ok: true; attached: number }
  | { ok: false; message: string; notReady: string[] };

interface ResolvedAsset {
  id: string;
  publicId: string;
  status: string;
  filename: string;
}

/**
 * Check a selection without writing anything.
 *
 * Separate from `attachAssetsToRequest` so the submit path can validate
 * *before* it claims a change from the allowance. Discovering that an image is
 * still processing after the client has been charged, and after a request row
 * exists, means unwinding both — and the old code's habit of unwinding badly
 * is most of why this rewrite happened.
 */
export async function validateAssetSelection(
  db: Database,
  ctx: TenantContext,
  assetPublicIds: string[],
): Promise<
  | { ok: true; assets: ResolvedAsset[] }
  | { ok: false; message: string; notReady: string[] }
> {
  const unique = [...new Set(assetPublicIds.filter(Boolean))];
  if (unique.length === 0) return { ok: true, assets: [] };

  if (unique.length > MAX_ASSETS_PER_REQUEST) {
    return {
      ok: false,
      notReady: [],
      message: `Please choose no more than ${MAX_ASSETS_PER_REQUEST} images for one request.`,
    };
  }

  const rows = await db
    .select({
      id: mediaAssets.id,
      publicId: mediaAssets.publicId,
      status: mediaAssets.status,
      filename: mediaAssets.originalFilename,
    })
    .from(mediaAssets)
    .where(
      and(
        // The tenancy filter. An id belonging to another client resolves to
        // nothing and is reported exactly like one that does not exist.
        eq(mediaAssets.organizationId, ctx.organizationId),
        inArray(mediaAssets.publicId, unique),
        sql`${mediaAssets.deletedAt} IS NULL`,
      ),
    );

  const found = new Map(rows.map((r) => [r.publicId, r]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      notReady: missing,
      message:
        missing.length === 1
          ? "One of the images you chose is no longer in your library."
          : "Some of the images you chose are no longer in your library.",
    };
  }

  const notReady = rows.filter((r) => r.status !== "ready");
  if (notReady.length > 0) {
    return {
      ok: false,
      notReady: notReady.map((r) => r.publicId),
      message:
        notReady.length === 1
          ? `"${notReady[0]!.filename}" is still being prepared. Give it a moment and send again — nothing you have typed will be lost.`
          : `${notReady.length} of those images are still being prepared. Give them a moment and send again — nothing you have typed will be lost.`,
    };
  }

  // Preserve the order the client chose: they will refer to "the second photo".
  return { ok: true, assets: unique.map((id) => found.get(id)!) };
}

/**
 * Attach library images to a request.
 *
 * Every id is resolved through the tenant's own organization *and* required to
 * be `ready`. An asset still processing has no derivatives, so an agent given
 * one would find a URL that serves nothing — a failure that surfaces much later
 * and looks like the agent's fault.
 *
 * Ids belonging to another tenant simply do not resolve, so they are reported
 * exactly like ids that do not exist.
 */
export async function attachAssetsToRequest(
  db: Database,
  ctx: TenantContext,
  requestId: string,
  assetPublicIds: string[],
): Promise<AttachResult> {
  const checked = await validateAssetSelection(db, ctx, assetPublicIds);
  if (!checked.ok) return checked;
  if (checked.assets.length === 0) return { ok: true, attached: 0 };

  await db
    .insert(requestAssets)
    .values(
      checked.assets.map((asset, index) => ({
        requestId,
        assetId: asset.id,
        position: index,
      })),
    )
    // Re-attaching the same asset to the same request is a retry, not a second
    // copy. Without this, an idempotent resubmit would double every link.
    .onConflictDoNothing();

  // Usage is recorded now, as `pending`. A client looking at an image should be
  // able to see it is spoken for before the change goes live, not only after —
  // that is exactly when they are deciding whether to delete it.
  await db
    .insert(mediaUsages)
    .values(
      checked.assets.map((asset) => ({
        assetId: asset.id,
        requestId,
        location: "Requested change",
        state: "pending",
      })),
    )
    .onConflictDoNothing();

  return { ok: true, attached: checked.assets.length };
}

/**
 * Freeze what the agent will be told, at the moment of dispatch.
 *
 * Called once per request, from the dispatch path. Rows already carrying a
 * `snapshot_at` are left alone: a re-dispatch after "ask for changes" must
 * reuse the inputs the first run had, or the second attempt is answering a
 * different question from the one the client asked.
 */
export async function snapshotRequestAssets(
  db: Database,
  requestId: string,
): Promise<number> {
  const pending = await db
    .select({
      linkId: requestAssets.id,
      title: mediaAssets.title,
      description: mediaAssets.description,
      filename: mediaAssets.originalFilename,
      checksum: mediaAssets.checksumSha256,
      width: mediaAssets.width,
      height: mediaAssets.height,
      orientation: mediaAssets.orientation,
      folderPath: mediaFolders.path,
    })
    .from(requestAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.id, requestAssets.assetId))
    .leftJoin(mediaFolders, eq(mediaFolders.id, mediaAssets.folderId))
    .where(
      and(eq(requestAssets.requestId, requestId), sql`${requestAssets.snapshotAt} IS NULL`),
    );

  const now = new Date();
  for (const row of pending) {
    const dims =
      row.width !== null && row.height !== null
        ? displayDimensions({
            width: row.width,
            height: row.height,
            orientation: row.orientation,
          })
        : { width: null, height: null };

    await db
      .update(requestAssets)
      .set({
        // Falls back to the filename so an untitled photo is still referable —
        // "Attachment 1" gives an agent nothing to match a sentence against.
        snapshotTitle: row.title?.trim() || row.filename,
        snapshotDescription: row.description?.trim() || null,
        snapshotChecksum: row.checksum,
        snapshotFolderPath: row.folderPath,
        snapshotWidth: dims.width,
        snapshotHeight: dims.height,
        snapshotAt: now,
      })
      .where(eq(requestAssets.id, row.linkId));
  }

  return pending.length;
}

/**
 * What a request carries, as the client sees it.
 *
 * Reads the snapshot where one exists and the live row where it does not, so a
 * request still being composed shows current values and a dispatched one shows
 * what was actually sent. Those are different questions and the answer should
 * differ.
 */
export async function listRequestAssets(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
): Promise<RequestAssetView[]> {
  const rows = await db
    .select({
      assetPublicId: mediaAssets.publicId,
      position: requestAssets.position,
      liveTitle: mediaAssets.title,
      liveDescription: mediaAssets.description,
      liveFolderPath: mediaFolders.path,
      liveWidth: mediaAssets.width,
      liveHeight: mediaAssets.height,
      orientation: mediaAssets.orientation,
      filename: mediaAssets.originalFilename,
      status: mediaAssets.status,
      snapshotTitle: requestAssets.snapshotTitle,
      snapshotDescription: requestAssets.snapshotDescription,
      snapshotFolderPath: requestAssets.snapshotFolderPath,
      snapshotWidth: requestAssets.snapshotWidth,
      snapshotHeight: requestAssets.snapshotHeight,
      snapshotAt: requestAssets.snapshotAt,
    })
    .from(requestAssets)
    .innerJoin(changeRequests, eq(changeRequests.id, requestAssets.requestId))
    .innerJoin(mediaAssets, eq(mediaAssets.id, requestAssets.assetId))
    .leftJoin(mediaFolders, eq(mediaFolders.id, mediaAssets.folderId))
    .where(
      and(
        eq(changeRequests.publicId, requestPublicId),
        // The tenancy boundary: reached only through a request this
        // organization owns.
        eq(changeRequests.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(asc(requestAssets.position));

  return rows.map((row) => {
    const live =
      row.liveWidth !== null && row.liveHeight !== null
        ? displayDimensions({
            width: row.liveWidth,
            height: row.liveHeight,
            orientation: row.orientation,
          })
        : { width: null, height: null };

    const frozen = row.snapshotAt !== null;
    return {
      assetPublicId: row.assetPublicId,
      position: row.position,
      title: frozen ? row.snapshotTitle : (row.liveTitle ?? row.filename),
      description: frozen ? row.snapshotDescription : row.liveDescription,
      folderPath: frozen ? row.snapshotFolderPath : row.liveFolderPath,
      width: frozen ? row.snapshotWidth : live.width,
      height: frozen ? row.snapshotHeight : live.height,
      filename: row.filename,
      status: row.status,
      snapshotted: frozen,
    };
  });
}

/**
 * Mark a request's images as live once its change reaches the site.
 *
 * Called when a request is verified. This is what turns "used in a pending
 * change" into "on your website", and it is derived from our own pipeline
 * rather than by reading the published page — which is why the UI says so.
 */
export async function markUsagePublished(
  db: Database,
  requestId: string,
  siteId: string | null,
  location: string,
): Promise<void> {
  await db
    .update(mediaUsages)
    .set({ state: "published", siteId, location, lastSeenAt: new Date() })
    .where(eq(mediaUsages.requestId, requestId));
}

/**
 * A cancelled or rejected request no longer uses its images.
 *
 * Leaving the rows at `pending` would tell a client an image is spoken for by
 * a change that will never happen, and the delete path would go on refusing to
 * remove it.
 */
export async function releaseUsage(db: Database, requestId: string): Promise<void> {
  await db
    .update(mediaUsages)
    .set({ state: "removed", lastSeenAt: new Date() })
    .where(eq(mediaUsages.requestId, requestId));
}
