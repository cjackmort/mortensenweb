import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { changeRequests, requestAttachments } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { newStorageKey, storageDriver } from "@/lib/storage/driver";
import type { ValidatedUpload } from "@/lib/storage";
import {
  assertMutable,
  NotFoundError,
  type TenantContext,
} from "../context";

/**
 * Change-request attachments, tenant-scoped.
 *
 * Every function here joins through `change_requests` and filters on
 * `ctx.organizationId`. That join is the isolation boundary: an attachment is
 * only ever reachable via a request the caller's own organization owns, so a
 * guessed attachment id resolves to `NotFoundError` — indistinguishable from a
 * row that does not exist, per the 404-not-403 rule.
 *
 * Bytes are written to object storage *before* the row is inserted. Getting
 * that order wrong leaves a row pointing at an object that was never written,
 * which reads as data loss; the reverse leaves an orphaned object, which is
 * merely garbage to collect.
 */

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Resolve a request the caller's organization owns, or throw. */
async function requireOwnRequest(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
): Promise<string> {
  const rows = await db
    .select({ id: changeRequests.id })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.publicId, requestPublicId),
        eq(changeRequests.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row.id;
}

export async function attachImageToRequest(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
  upload: ValidatedUpload,
) {
  assertMutable(ctx);
  const requestId = await requireOwnRequest(db, ctx, requestPublicId);

  const key = newStorageKey(upload.extension);
  await storageDriver().put({
    key,
    bytes: upload.bytes,
    contentType: upload.contentType,
  });

  const inserted = await db
    .insert(requestAttachments)
    .values({
      publicId: newPublicId(),
      requestId,
      r2Key: key,
      filenameOriginal: upload.displayName,
      // Both are recorded because they answer different questions later: what
      // the browser claimed, and what the bytes actually were.
      contentTypeDeclared: upload.contentType,
      contentTypeSniffed: upload.contentType,
      byteSize: upload.size,
      checksumSha256: await sha256OfBytes(upload.bytes),
      uploadedBy: ctx.userId,
      // No malware scanner is wired up yet. `pending` is the honest state, and
      // the serving path refuses anything a scanner later marks `flagged`.
      scanStatus: "pending",
    })
    .returning({ publicId: requestAttachments.publicId });

  return inserted[0]!;
}

export async function listRequestAttachments(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
) {
  const requestId = await requireOwnRequest(db, ctx, requestPublicId);

  return db
    .select({
      publicId: requestAttachments.publicId,
      filenameOriginal: requestAttachments.filenameOriginal,
      byteSize: requestAttachments.byteSize,
      contentTypeSniffed: requestAttachments.contentTypeSniffed,
      scanStatus: requestAttachments.scanStatus,
      createdAt: requestAttachments.createdAt,
    })
    .from(requestAttachments)
    .where(eq(requestAttachments.requestId, requestId))
    .orderBy(requestAttachments.createdAt);
}

/** How many images a request already carries, for the per-request cap. */
export async function countRequestAttachments(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
): Promise<number> {
  const rows = await listRequestAttachments(db, ctx, requestPublicId);
  return rows.length;
}

/**
 * Fetch one attachment's bytes for serving.
 *
 * Scoped through the request's organization, so this cannot be used to read
 * another tenant's image by guessing a public id.
 */
export async function getAttachmentForTenant(
  db: Database,
  ctx: TenantContext,
  attachmentPublicId: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string } | null> {
  const rows = await db
    .select({
      r2Key: requestAttachments.r2Key,
      contentTypeSniffed: requestAttachments.contentTypeSniffed,
      filenameOriginal: requestAttachments.filenameOriginal,
      scanStatus: requestAttachments.scanStatus,
    })
    .from(requestAttachments)
    .innerJoin(
      changeRequests,
      eq(requestAttachments.requestId, changeRequests.id),
    )
    .where(
      and(
        eq(requestAttachments.publicId, attachmentPublicId),
        eq(changeRequests.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();
  // `flagged` is the scanner's "do not serve this". Checked here rather than at
  // upload because a scan can land after the row exists.
  if (row.scanStatus === "flagged") return null;

  const object = await storageDriver().get(row.r2Key);
  if (!object) return null;

  return {
    bytes: object.bytes,
    // The database is authoritative for content type, not the storage layer and
    // certainly not the request. Serving a client-influenced type is how an
    // "image" gets interpreted as HTML.
    contentType: row.contentTypeSniffed ?? "application/octet-stream",
    filename: row.filenameOriginal ?? "image",
  };
}
