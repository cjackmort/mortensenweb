import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  mediaAssets,
  mediaJobs,
  mediaUploadParts,
  mediaUploads,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  MAX_ORIGINAL_BYTES,
  UPLOAD_PART_BYTES,
  UPLOAD_SESSION_TTL_MINUTES,
} from "@/lib/media/constants";
import { FORMAT_EXTENSIONS } from "@/lib/media/constants";
import { REJECTION_EXPLANATIONS, sniffImageFormat } from "@/lib/media/probe";
import {
  mediaDriver,
  originalKey,
  uploadPartKey,
} from "@/lib/storage/driver";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { requireOwnFolder } from "./media-folders";
import {
  adjustReservation,
  releaseStorage,
  reserveStorage,
} from "./media-quota";

/**
 * Chunked uploads.
 *
 * ## Why this exists at all
 *
 * Netlify runs functions on AWS Lambda, which caps a synchronous request body
 * at 6 MB — and binary content is base64-encoded on the way in, so the real
 * ceiling is about 4.5 MB. It cannot be raised on any plan. Netlify Blobs, the
 * store this platform already uses, offers no presigned upload URL, so the
 * browser cannot write to storage directly either.
 *
 * Between those two facts, there is no way for an original-resolution photo to
 * reach storage in one request. It arrives in parts.
 *
 * ## The properties this buys, which the old path did not have
 *
 *  - **Retry is per part.** A dropped connection costs one 3 MB part, not the
 *    whole 40 MB file and not the client's typed request.
 *  - **A part is idempotent.** `(upload_id, part_number)` is unique, so sending
 *    the same part twice is one row and one object. Retry is therefore always
 *    safe, including a retry the browser makes on its own.
 *  - **Completion is a server decision.** The client says "done"; the server
 *    then reads every part it holds, checks the count, checks the total size,
 *    recomputes SHA-256 over the assembled bytes and compares it against what
 *    was declared when the session opened, and sniffs the format from the
 *    bytes. An asset becomes usable only if all of that agrees.
 *
 * ## Ordering, in the absence of transactions
 *
 * The Neon HTTP driver has no interactive transactions, so the sequence is
 * chosen to make every interruption recoverable rather than to be atomic:
 * bytes are written before rows point at them, and rows are marked `ready` only
 * once the object exists. An interruption leaves an orphan object, which the
 * sweeper collects. The reverse would leave a row promising bytes that were
 * never written, which reads as data loss.
 */

export interface BeginUploadInput {
  filename: string;
  declaredBytes: number;
  /** Lowercase hex SHA-256, computed by the browser over the whole file. */
  declaredChecksum: string;
  declaredContentType: string;
  folderPublicId?: string | null;
}

export type BeginUploadResult =
  | {
      ok: true;
      uploadPublicId: string;
      assetPublicId: string;
      partSize: number;
      partCount: number;
      /** Parts already held, so a resumed session skips what it has. */
      receivedParts: number[];
    }
  | { ok: false; reason: "too_large" | "invalid" | "quota"; message: string };

const HEX_64 = /^[0-9a-f]{64}$/;

/** Strip a submitted filename to something safe to store and display. */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "image";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200) || "image";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Open an upload session.
 *
 * The quota is checked here, before any bytes move. Refusing at the end of a
 * 40 MB upload would be correct and infuriating.
 */
export async function beginUpload(
  db: Database,
  ctx: TenantContext,
  input: BeginUploadInput,
): Promise<BeginUploadResult> {
  assertMutable(ctx);

  const filename = safeFilename(input.filename);
  const bytes = Math.floor(input.declaredBytes);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, reason: "invalid", message: "That file appears to be empty." };
  }
  if (bytes > MAX_ORIGINAL_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `That image is ${Math.round(bytes / 1024 / 1024)} MB. The limit is ${Math.floor(
        MAX_ORIGINAL_BYTES / 1024 / 1024,
      )} MB per image.`,
    };
  }
  if (!HEX_64.test(input.declaredChecksum)) {
    return { ok: false, reason: "invalid", message: "That upload could not be started." };
  }

  let folderId: string | null = null;
  if (input.folderPublicId) {
    try {
      folderId = (await requireOwnFolder(db, ctx, input.folderPublicId)).id;
    } catch {
      return { ok: false, reason: "invalid", message: "We couldn't find that folder." };
    }
  }

  /*
   * Claim the room before anything moves.
   *
   * One statement, row-locked, so the comparison and the increment cannot be
   * separated — see `media-quota.ts` for why a `SUM` could not do this. The
   * claim is for the *declared* size; `completeUpload` trues it up to what
   * actually arrived, and abort or sweep hands it all back.
   */
  const reservation = await reserveStorage(db, ctx, bytes);
  if (!reservation.ok) {
    if (reservation.reason === "no_client") {
      return {
        ok: false,
        reason: "invalid",
        message:
          "Your account is not linked to a client record yet. Please contact us.",
      };
    }
    const freeMb = Math.floor(reservation.freeBytes / 1024 / 1024);
    return {
      ok: false,
      reason: "quota",
      message: `This would go over your storage allowance — you have about ${freeMb} MB free. Emptying the trash frees space, or get in touch and we will raise it.`,
    };
  }

  const assetPublicId = newPublicId();
  const uploadPublicId = newPublicId();
  const partCount = Math.max(1, Math.ceil(bytes / UPLOAD_PART_BYTES));

  try {
    const inserted = await db
    .insert(mediaAssets)
    .values({
      publicId: assetPublicId,
      organizationId: ctx.organizationId,
      folderId,
      status: "uploading",
      originalFilename: filename,
      // The declared size, not zero: this row *is* the quota reservation for
      // the duration of the session. `completeUpload` overwrites it with the
      // size actually assembled, so a client who declares 16 MB and sends 2 MB
      // holds the larger figure only until they finish or the sweeper collects
      // them — never permanently.
      byteSize: bytes,
      uploadedBy: ctx.userId,
    })
    .returning({ id: mediaAssets.id });

  await db.insert(mediaUploads).values({
    publicId: uploadPublicId,
    organizationId: ctx.organizationId,
    assetId: inserted[0]!.id,
    declaredBytes: bytes,
    declaredChecksum: input.declaredChecksum.toLowerCase(),
    declaredFilename: filename,
    declaredContentType: input.declaredContentType.slice(0, 100),
    partSize: UPLOAD_PART_BYTES,
    partCount,
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MINUTES * 60_000),
    createdBy: ctx.userId,
  });

    return {
      ok: true,
      uploadPublicId,
      assetPublicId,
      partSize: UPLOAD_PART_BYTES,
      partCount,
      receivedParts: [],
    };
  } catch (error) {
    // The room was claimed and the session was not created. Give it back, or
    // the tenant loses that much allowance permanently — the counter would say
    // bytes are held by something that does not exist.
    await releaseStorage(db, ctx.organizationId, bytes);
    throw error;
  }
}

interface SessionRow {
  id: string;
  assetId: string;
  status: "pending" | "completed" | "aborted";
  declaredBytes: number;
  declaredChecksum: string;
  declaredFilename: string;
  partSize: number;
  partCount: number;
  publicId: string;
  expiresAt: Date;
}

/** Resolve a session this tenant owns. Cross-tenant reads resolve to not-found. */
async function requireOwnSession(
  db: Database,
  ctx: TenantContext,
  uploadPublicId: string,
): Promise<SessionRow> {
  const rows = await db
    .select({
      id: mediaUploads.id,
      assetId: mediaUploads.assetId,
      status: mediaUploads.status,
      declaredBytes: mediaUploads.declaredBytes,
      declaredChecksum: mediaUploads.declaredChecksum,
      declaredFilename: mediaUploads.declaredFilename,
      partSize: mediaUploads.partSize,
      partCount: mediaUploads.partCount,
      publicId: mediaUploads.publicId,
      expiresAt: mediaUploads.expiresAt,
    })
    .from(mediaUploads)
    .where(
      and(
        eq(mediaUploads.publicId, uploadPublicId),
        eq(mediaUploads.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row as SessionRow;
}

/** Which parts a session already holds. Lets a resumed upload skip them. */
export async function receivedPartNumbers(
  db: Database,
  ctx: TenantContext,
  uploadPublicId: string,
): Promise<number[]> {
  const session = await requireOwnSession(db, ctx, uploadPublicId);
  const rows = await db
    .select({ partNumber: mediaUploadParts.partNumber })
    .from(mediaUploadParts)
    .where(eq(mediaUploadParts.uploadId, session.id))
    .orderBy(asc(mediaUploadParts.partNumber));
  return rows.map((r) => r.partNumber);
}

export type PartResult =
  | { ok: true; received: number; total: number }
  | { ok: false; message: string };

/**
 * Store one part.
 *
 * The object is written before the row, and the row is an upsert — so a retry
 * of the same part overwrites identical bytes and updates one row, rather than
 * appending a second copy that assembly would then concatenate twice.
 */
export async function storeUploadPart(
  db: Database,
  ctx: TenantContext,
  uploadPublicId: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<PartResult> {
  assertMutable(ctx);

  const session = await requireOwnSession(db, ctx, uploadPublicId);

  if (session.status !== "pending") {
    return { ok: false, message: "That upload has already finished." };
  }
  if (session.expiresAt.getTime() < Date.now()) {
    return { ok: false, message: "That upload took too long and was cancelled. Please try again." };
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
    return { ok: false, message: "That upload could not be continued." };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, message: "That part was empty." };
  }
  // A part may not exceed the size the session agreed. Without this, a client
  // could declare a 1 MB file, then send parts totalling a gigabyte — the quota
  // check at `beginUpload` would have approved something else entirely.
  if (bytes.byteLength > session.partSize) {
    return { ok: false, message: "That part was larger than expected." };
  }

  const key = uploadPartKey(session.publicId, partNumber);
  await mediaDriver().put({
    key,
    bytes,
    contentType: "application/octet-stream",
  });

  await db
    .insert(mediaUploadParts)
    .values({
      uploadId: session.id,
      partNumber,
      storageKey: key,
      byteSize: bytes.byteLength,
      checksumSha256: await sha256Hex(bytes),
    })
    .onConflictDoUpdate({
      target: [mediaUploadParts.uploadId, mediaUploadParts.partNumber],
      set: {
        byteSize: bytes.byteLength,
        checksumSha256: await sha256Hex(bytes),
        createdAt: new Date(),
      },
    });

  const counted = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(mediaUploadParts)
    .where(eq(mediaUploadParts.uploadId, session.id));

  return {
    ok: true,
    received: Number(counted[0]?.count ?? 0),
    total: session.partCount,
  };
}

export type CompleteResult =
  | { ok: true; assetPublicId: string; width: number; height: number }
  | { ok: false; message: string; retryable: boolean };

/**
 * Assemble, verify, and admit the asset.
 *
 * Everything the browser told us at `beginUpload` is treated as a claim to be
 * checked here, and the checks are ordered cheapest-first so a wrong answer
 * costs the least work:
 *
 *  1. Are all the parts present? (one query)
 *  2. Do they total the declared size? (arithmetic)
 *  3. Does the assembled SHA-256 match what was declared? (one pass)
 *  4. Is it actually an image we support, by its bytes? (header parse)
 *
 * Only then is anything written, and the asset is left at `processing` rather
 * than `ready` — the derivative job promotes it. An image with no thumbnail is
 * not yet something the library can honestly offer.
 */
export async function completeUpload(
  db: Database,
  ctx: TenantContext,
  uploadPublicId: string,
): Promise<CompleteResult> {
  assertMutable(ctx);

  const session = await requireOwnSession(db, ctx, uploadPublicId);

  // Completing twice is not an error. A retried "complete" after a dropped
  // response must find the finished asset rather than start again.
  if (session.status === "completed") {
    const existing = await db
      .select({
        publicId: mediaAssets.publicId,
        width: mediaAssets.width,
        height: mediaAssets.height,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, session.assetId))
      .limit(1);
    const row = existing[0];
    if (row) {
      return {
        ok: true,
        assetPublicId: row.publicId,
        width: row.width ?? 0,
        height: row.height ?? 0,
      };
    }
  }

  if (session.status === "aborted") {
    return { ok: false, message: "That upload was cancelled.", retryable: false };
  }

  const parts = await db
    .select({
      partNumber: mediaUploadParts.partNumber,
      storageKey: mediaUploadParts.storageKey,
      byteSize: mediaUploadParts.byteSize,
    })
    .from(mediaUploadParts)
    .where(eq(mediaUploadParts.uploadId, session.id))
    .orderBy(asc(mediaUploadParts.partNumber));

  if (parts.length !== session.partCount) {
    const missing = session.partCount - parts.length;
    return {
      ok: false,
      retryable: true,
      message: `${missing} ${missing === 1 ? "piece" : "pieces"} of that image did not arrive. Retrying will send just the missing ${missing === 1 ? "piece" : "pieces"}.`,
    };
  }

  const declaredTotal = Number(session.declaredBytes);
  const actualTotal = parts.reduce((sum, p) => sum + Number(p.byteSize), 0);
  if (actualTotal !== declaredTotal) {
    return {
      ok: false,
      retryable: true,
      message: "That image did not arrive intact. Please try uploading it again.",
    };
  }

  // Read the parts back and assemble. Bounded by MAX_ORIGINAL_BYTES, which is
  // well inside the function's memory — but the bound is what makes that true,
  // so it is enforced at `beginUpload` rather than assumed here.
  const driver = mediaDriver();
  const assembled = new Uint8Array(actualTotal);
  let offset = 0;
  for (const part of parts) {
    const object = await driver.get(part.storageKey);
    if (!object) {
      return {
        ok: false,
        retryable: true,
        message: "Part of that image is missing from storage. Please upload it again.",
      };
    }
    assembled.set(object.bytes, offset);
    offset += object.bytes.byteLength;
  }

  if (offset !== actualTotal) {
    return {
      ok: false,
      retryable: true,
      message: "That image did not arrive intact. Please try uploading it again.",
    };
  }

  const digest = await sha256Hex(assembled);
  if (digest !== session.declaredChecksum) {
    // The parts that arrived are not the file that was chosen. Corruption, or
    // content substituted mid-session. Either way this is not storable.
    await failAsset(db, session.assetId, "The image did not match its checksum.");
    await db
      .update(mediaUploads)
      .set({ status: "aborted", updatedAt: new Date() })
      .where(eq(mediaUploads.id, session.id));
    // Nothing usable was stored, so the room goes back.
    await releaseStorage(db, ctx.organizationId, Number(session.declaredBytes));
    return {
      ok: false,
      retryable: true,
      message: "That image arrived damaged and was not saved. Please try uploading it again.",
    };
  }

  const sniffed = sniffImageFormat(assembled);
  if (!sniffed.ok) {
    await failAsset(db, session.assetId, REJECTION_EXPLANATIONS[sniffed.detected]);
    await db
      .update(mediaUploads)
      .set({ status: "aborted", updatedAt: new Date() })
      .where(eq(mediaUploads.id, session.id));
    await releaseStorage(db, ctx.organizationId, Number(session.declaredBytes));
    return {
      ok: false,
      retryable: false,
      message: REJECTION_EXPLANATIONS[sniffed.detected],
    };
  }

  const probe = sniffed.probe;
  const assetPublicIdRows = await db
    .select({ publicId: mediaAssets.publicId })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, session.assetId))
    .limit(1);
  const assetPublicId = assetPublicIdRows[0]?.publicId;
  if (!assetPublicId) {
    return { ok: false, retryable: false, message: "That upload could not be completed." };
  }

  // Bytes first, then the row that points at them.
  const key = originalKey(assetPublicId, FORMAT_EXTENSIONS[probe.format]);
  await driver.put({ key, bytes: assembled, contentType: probe.contentType });

  await db
    .update(mediaAssets)
    .set({
      status: "processing",
      storageKey: key,
      contentType: probe.contentType,
      byteSize: actualTotal,
      checksumSha256: digest,
      width: probe.width,
      height: probe.height,
      hasAlpha: probe.hasAlpha,
      orientation: probe.orientation,
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.id, session.assetId));

  await db
    .update(mediaUploads)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(mediaUploads.id, session.id));

  // The reservation was for the declared size; charge what actually arrived.
  // Unconditional, because the bytes are already in storage — refusing here
  // would leave the counter disagreeing with reality.
  await adjustReservation(
    db,
    ctx.organizationId,
    actualTotal - Number(session.declaredBytes),
  );

  // Queue derivatives. `onConflictDoNothing` against the partial unique index
  // means a retried completion does not enqueue a second job for one asset.
  await db
    .insert(mediaJobs)
    .values({ publicId: newPublicId(), assetId: session.assetId })
    .onConflictDoNothing();

  // The parts are now redundant. Failing to remove them wastes space but breaks
  // nothing, so this must never fail the completion the client is waiting on.
  void cleanUpParts(parts.map((p) => p.storageKey));

  const display =
    probe.orientation >= 5 && probe.orientation <= 8
      ? { width: probe.height, height: probe.width }
      : { width: probe.width, height: probe.height };

  return { ok: true, assetPublicId, width: display.width, height: display.height };
}

async function cleanUpParts(keys: string[]): Promise<void> {
  const driver = mediaDriver();
  for (const key of keys) {
    try {
      await driver.delete(key);
    } catch {
      // The sweeper will find it. A failed tidy-up is not worth an error path.
    }
  }
}

async function failAsset(db: Database, assetId: string, reason: string): Promise<void> {
  await db
    .update(mediaAssets)
    .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
    .where(eq(mediaAssets.id, assetId));
}

/** Give up on a session — the client cancelled, or navigated away and came back. */
export async function abortUpload(
  db: Database,
  ctx: TenantContext,
  uploadPublicId: string,
): Promise<{ ok: boolean }> {
  assertMutable(ctx);
  const session = await requireOwnSession(db, ctx, uploadPublicId);
  if (session.status === "completed") return { ok: false };

  await db
    .update(mediaUploads)
    .set({ status: "aborted", updatedAt: new Date() })
    .where(eq(mediaUploads.id, session.id));

  // The placeholder asset never became anything. Removing it keeps the library
  // honest and releases the quota it was holding.
  await db
    .delete(mediaAssets)
    .where(
      and(eq(mediaAssets.id, session.assetId), eq(mediaAssets.status, "uploading")),
    );

  await releaseStorage(db, ctx.organizationId, Number(session.declaredBytes));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

/**
 * Collect abandoned uploads.
 *
 * A client who closes the tab mid-upload leaves a pending session, some part
 * objects, and a placeholder asset holding quota. None of that is reachable
 * from any screen, so nothing will ever finish it. Past its expiry it is
 * garbage, and this is what takes it out.
 *
 * Runs from the scheduled tick. Bounded per run so one sweep cannot monopolise
 * the function's budget.
 */
export async function sweepExpiredUploads(
  db: Database,
  limit = 25,
): Promise<{ sessions: number; objects: number }> {
  const stale = await db
    .select({
      id: mediaUploads.id,
      publicId: mediaUploads.publicId,
      assetId: mediaUploads.assetId,
      organizationId: mediaUploads.organizationId,
      declaredBytes: mediaUploads.declaredBytes,
    })
    .from(mediaUploads)
    .where(
      and(eq(mediaUploads.status, "pending"), lt(mediaUploads.expiresAt, new Date())),
    )
    .limit(limit);

  if (stale.length === 0) return { sessions: 0, objects: 0 };

  const driver = mediaDriver();
  let objects = 0;

  for (const session of stale) {
    const parts = await db
      .select({ storageKey: mediaUploadParts.storageKey })
      .from(mediaUploadParts)
      .where(eq(mediaUploadParts.uploadId, session.id));

    for (const part of parts) {
      try {
        await driver.delete(part.storageKey);
        objects += 1;
      } catch {
        // Leave the row so the next sweep tries again.
      }
    }

    await db
      .update(mediaUploads)
      .set({ status: "aborted", updatedAt: new Date() })
      .where(eq(mediaUploads.id, session.id));

    // Only ever the placeholder. An asset that reached `processing` or beyond
    // has real bytes and belongs to the client, whatever its session did.
    const removed = await db
      .delete(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, session.assetId),
          eq(mediaAssets.status, "uploading"),
          isNull(mediaAssets.storageKey),
        ),
      )
      .returning({ id: mediaAssets.id });

    // Only release when the placeholder was actually removed. An asset that
    // reached `processing` has real bytes and keeps its room; releasing for it
    // would let the tenant store the same bytes twice over.
    if (removed.length > 0) {
      await releaseStorage(
        db,
        session.organizationId,
        Number(session.declaredBytes),
      );
    }
  }

  return { sessions: stale.length, objects };
}
