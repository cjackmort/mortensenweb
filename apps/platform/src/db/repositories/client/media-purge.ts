import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  mediaAssets,
  mediaDerivatives,
  requestAssets,
} from "@/db/schema";
import { storageDriver } from "@/lib/storage/driver";
import { BLOCKING_STATUSES } from "@/lib/requests/status";
import { assertMutable, type TenantContext } from "../context";
import { releaseStorage } from "./media-quota";

/**
 * Deleting photos for good — "Delete forever" and "Empty trash".
 *
 * The second of two steps. Deleting a photo moves it to the trash, where the
 * bytes stay and still count against the client's storage; this is what lets
 * that space go. It only ever acts on photos already in the trash, so nothing
 * leaves the library in one click: the cost of keeping bytes someone meant to
 * discard is storage, and the cost of the other mistake is the only copy of a
 * painting.
 *
 * ## Order of work, per photo
 *
 * The stored files are removed first and the record second. If a file cannot
 * be removed the record stays — in the trash, still counted — and the client
 * is told; they can try again. The other order would leave bytes in storage
 * that no record points at and no screen shows, which is a leak nobody would
 * ever see.
 *
 * ## What holds a photo back
 *
 * A change still in progress that uses it: the agent may still need to
 * download it. Once that change is finished the site has its own copy, so the
 * library's can go — and its link to that finished request goes with it.
 */

export interface PurgeOutcome {
  ok: boolean;
  message: string;
  purged: number;
  /** Public ids held back because a change in progress uses them. */
  kept: string[];
  /** Photos whose files could not be removed; they stay in the trash. */
  failed: number;
  freedBytes: number;
}

export interface Hold {
  assetPublicId: string;
  assetName: string;
  requestTitle: string;
}

/** The photos among these that a change still in progress depends on. */
export async function heldByChangesInProgress(
  db: Database,
  organizationId: string,
  assetPublicIds: string[],
): Promise<Hold[]> {
  if (assetPublicIds.length === 0) return [];

  const rows = await db
    .select({
      assetPublicId: mediaAssets.publicId,
      assetFilename: mediaAssets.originalFilename,
      assetTitle: mediaAssets.title,
      requestTitle: changeRequests.title,
    })
    .from(requestAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.id, requestAssets.assetId))
    .innerJoin(changeRequests, eq(changeRequests.id, requestAssets.requestId))
    .where(
      and(
        eq(mediaAssets.organizationId, organizationId),
        inArray(mediaAssets.publicId, assetPublicIds),
        inArray(changeRequests.status, [...BLOCKING_STATUSES]),
      ),
    );

  return rows.map((row) => ({
    assetPublicId: row.assetPublicId,
    assetName: row.assetTitle ?? row.assetFilename,
    requestTitle: row.requestTitle,
  }));
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Remove one photo's files, then its record. Returns the bytes freed, or null
 * if any file could not be removed — in which case nothing else was touched.
 */
async function purgeOne(
  db: Database,
  asset: { id: string; storageKey: string | null; byteSize: number | null },
): Promise<number | null> {
  const derivatives = await db
    .select({ storageKey: mediaDerivatives.storageKey, byteSize: mediaDerivatives.byteSize })
    .from(mediaDerivatives)
    .where(eq(mediaDerivatives.assetId, asset.id));

  const keys = [asset.storageKey, ...derivatives.map((d) => d.storageKey)].filter(
    (key): key is string => Boolean(key),
  );

  const driver = storageDriver();
  try {
    for (const key of keys) await driver.delete(key);
  } catch (error) {
    console.error("[media] could not remove stored files", {
      assetId: asset.id,
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }

  // Links to finished requests only — a request in progress held this photo
  // back before we got here. The schema refuses to delete a referenced asset.
  await db.delete(requestAssets).where(eq(requestAssets.assetId, asset.id));
  // Derivatives, jobs and usage rows go with it (cascade).
  await db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id));

  return (asset.byteSize ?? 0) + derivatives.reduce((sum, d) => sum + Number(d.byteSize), 0);
}

function describe(purged: number, freed: number, holds: Hold[], failed: number): string {
  const parts: string[] = [];
  if (purged > 0) {
    parts.push(
      `${purged === 1 ? "Deleted for good" : `${purged} photos deleted for good`}, freeing ${formatMb(freed)}.`,
    );
  }
  if (holds.length > 0) {
    const first = holds[0]!;
    parts.push(
      holds.length === 1
        ? `"${first.assetName}" was kept, because your request "${first.requestTitle}" still needs it. It can go once that change is finished.`
        : `${holds.length} were kept, because a change still in progress needs them.`,
    );
  }
  if (failed > 0) {
    parts.push(
      `${failed === 1 ? "One photo" : `${failed} photos`} couldn't be removed just now and ${failed === 1 ? "is" : "are"} still in the trash. Please try again in a minute.`,
    );
  }
  return parts.join(" ") || "There was nothing in the trash to delete.";
}

/**
 * Delete trashed photos for good. With no ids, empties the whole trash.
 *
 * Only ever touches this tenant's photos, and only ones already in the trash.
 */
export async function purgeAssets(
  db: Database,
  ctx: TenantContext,
  publicIds?: string[],
): Promise<PurgeOutcome> {
  assertMutable(ctx);

  const trashed = await db
    .select({
      id: mediaAssets.id,
      publicId: mediaAssets.publicId,
      storageKey: mediaAssets.storageKey,
      byteSize: mediaAssets.byteSize,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        isNotNull(mediaAssets.deletedAt),
        ...(publicIds ? [inArray(mediaAssets.publicId, publicIds.length ? publicIds : [""])] : []),
      ),
    );

  const holds = await heldByChangesInProgress(
    db,
    ctx.organizationId,
    trashed.map((a) => a.publicId),
  );
  const held = new Set(holds.map((h) => h.assetPublicId));

  let purged = 0;
  let failed = 0;
  let freedBytes = 0;

  for (const asset of trashed) {
    if (held.has(asset.publicId)) continue;
    const freed = await purgeOne(db, asset);
    if (freed === null) {
      failed += 1;
      continue;
    }
    purged += 1;
    freedBytes += freed;
  }

  await releaseStorage(db, ctx.organizationId, freedBytes);

  return {
    ok: purged > 0,
    message: describe(purged, freedBytes, holds, failed),
    purged,
    kept: [...held],
    failed,
    freedBytes,
  };
}
