import { and, eq, isNull, or, isNotNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { sites } from "@/db/schema";
import { siteHomeUrl } from "@/components/site-preview";
import { thumbnailDriver, thumbnailKey } from "@/lib/storage/driver";
import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * Pictures of client home pages for the admin tiles.
 *
 * The tiles used to load a picture each site's own deploy published, and no
 * site's deploy publishes one, so every tile showed a letter. These are taken
 * by a scheduled GitHub Action instead (`.github/workflows/site-thumbnails.yml`)
 * and kept here, so a tile works whatever a site is built with.
 *
 * Writing is the job's alone: it holds CRON_SECRET, the same secret the
 * scheduled tick uses. Reading is through a session-checked route.
 */

export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The scheduled job's shared secret, compared in constant time. */
export function hasCronSecret(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const provided = request.headers.get("x-cron-secret") ?? "";
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(provided), encoder.encode(expected));
}

export interface ThumbnailTarget {
  publicId: string;
  url: string;
}

/** Every site worth photographing: has an address, is not archived, is not shown live. */
export async function listThumbnailTargets(db: Database): Promise<ThumbnailTarget[]> {
  const rows = await db
    .select({
      publicId: sites.publicId,
      primaryDomain: sites.primaryDomain,
      productionUrl: sites.productionUrl,
      netlifySiteName: sites.netlifySiteName,
    })
    .from(sites)
    .where(
      and(
        isNull(sites.archivedAt),
        eq(sites.previewMode, "screenshot"),
        or(isNotNull(sites.primaryDomain), isNotNull(sites.productionUrl), isNotNull(sites.netlifySiteName)),
      ),
    );

  return rows.flatMap((row) => {
    const url = siteHomeUrl(row);
    return url ? [{ publicId: row.publicId, url }] : [];
  });
}

export type SaveThumbnailResult =
  | { ok: true }
  | { ok: false; reason: "unknown_site" | "not_jpeg" | "too_large" };

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export async function saveThumbnail(
  db: Database,
  sitePublicId: string,
  bytes: Uint8Array,
): Promise<SaveThumbnailResult> {
  if (!PUBLIC_ID.test(sitePublicId)) return { ok: false, reason: "unknown_site" };
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) return { ok: false, reason: "too_large" };
  if (!isJpeg(bytes)) return { ok: false, reason: "not_jpeg" };

  const found = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.publicId, sitePublicId))
    .limit(1);
  if (!found[0]) return { ok: false, reason: "unknown_site" };

  await thumbnailDriver().put({ key: thumbnailKey(sitePublicId), bytes, contentType: "image/jpeg" });
  return { ok: true };
}

export async function readThumbnail(sitePublicId: string): Promise<{ bytes: Uint8Array } | null> {
  if (!PUBLIC_ID.test(sitePublicId)) return null;
  const stored = await thumbnailDriver().get(thumbnailKey(sitePublicId));
  return stored ? { bytes: stored.bytes } : null;
}
