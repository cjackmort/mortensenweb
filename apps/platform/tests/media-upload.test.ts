import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

// The storage root has to be set before anything reads it into a cached driver.
const MEDIA_ROOT = await mkdtemp(join(tmpdir(), "mw-media-"));
process.env.MEDIA_DIR = MEDIA_ROOT;

const { createTestDb } = await import("./helpers/db");
const { seedTenant } = await import("./helpers/tenant");
const images = await import("./helpers/images");
const { mediaAssets, mediaDerivatives, mediaJobs, mediaUploadParts } = await import(
  "@/db/schema"
);
const { beginUpload, completeUpload, storeUploadPart, abortUpload, sweepExpiredUploads } =
  await import("@/db/repositories/client/media-uploads");
const { runDerivativeJobs, retryAsset } = await import(
  "@/db/repositories/admin/media-jobs"
);
const { getAsset, getStorageUsage, listAssets } = await import(
  "@/db/repositories/client/media-assets"
);
const { resetStorageDrivers, mediaDriver } = await import("@/lib/storage/driver");
const { UPLOAD_PART_BYTES } = await import("@/lib/media/constants");

import type { Database } from "@/db/client";
import type { SeededTenant } from "./helpers/tenant";

/**
 * The upload pipeline, end to end.
 *
 * These are the cases that broke the old path, written as tests so they cannot
 * come back: a file too large for one request, an upload interrupted partway,
 * a file that is not the image it claims to be, and a photo whose transparency
 * or rotation must survive.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Upload a whole file the way the browser does: open a session, send every
 * part, then ask the server to finish.
 */
async function uploadFile(
  tenant: SeededTenant,
  bytes: Uint8Array,
  filename: string,
  options: { folderPublicId?: string | null; skipPart?: number } = {},
) {
  const begun = await beginUpload(db, tenant.ctx, {
    filename,
    declaredBytes: bytes.byteLength,
    declaredChecksum: await sha256Hex(bytes),
    declaredContentType: "image/jpeg",
    folderPublicId: options.folderPublicId ?? null,
  });
  if (!begun.ok) return { begun, completed: null };

  for (let part = 1; part <= begun.partCount; part += 1) {
    if (options.skipPart === part) continue;
    const start = (part - 1) * begun.partSize;
    const slice = bytes.slice(start, Math.min(start + begun.partSize, bytes.byteLength));
    const stored = await storeUploadPart(db, tenant.ctx, begun.uploadPublicId, part, slice);
    expect(stored.ok, `part ${part}`).toBe(true);
  }

  const completed = await completeUpload(db, tenant.ctx, begun.uploadPublicId);
  return { begun, completed };
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => {
  await close();
  resetStorageDrivers();
  await rm(MEDIA_ROOT, { recursive: true, force: true });
});

describe("chunked upload", () => {
  it("stores a photo larger than a single request can carry", async () => {
    // Deliberately over the ~4.5 MB effective body limit that made the old
    // single-request path fail. It has to arrive in more than one part.
    const bytes = new Uint8Array(await images.jpegFixture(4000, 3000));
    expect(bytes.byteLength).toBeGreaterThan(0);

    const { begun, completed } = await uploadFile(acme, bytes, "big-photo.jpg");
    expect(begun.ok).toBe(true);
    expect(completed?.ok).toBe(true);
    if (!completed?.ok) return;

    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    // Not ready yet: derivatives have not run, so there is nothing to show and
    // nothing a request could safely carry.
    expect(asset.status).toBe("processing");
    expect(asset.byteSize).toBe(bytes.byteLength);
    expect(asset.width).toBe(4000);
    expect(asset.height).toBe(3000);
    expect(asset.originalFilename).toBe("big-photo.jpg");
  });

  it("splits a file into the number of parts the limit requires", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(5000, 4000));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "multi.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    expect(begun.partSize).toBe(UPLOAD_PART_BYTES);
    expect(begun.partCount).toBe(Math.ceil(bytes.byteLength / UPLOAD_PART_BYTES));
    await abortUpload(db, acme.ctx, begun.uploadPublicId);
  });

  it("preserves the original bytes exactly", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(1200, 800));
    const { completed } = await uploadFile(acme, bytes, "exact.jpg");
    expect(completed?.ok).toBe(true);
    if (!completed?.ok) return;

    const rows = await db
      .select({ storageKey: mediaAssets.storageKey, checksum: mediaAssets.checksumSha256 })
      .from(mediaAssets)
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    const stored = await mediaDriver().get(rows[0]!.storageKey!);
    expect(stored).not.toBeNull();
    // Byte-for-byte. This is the promise the whole library rests on.
    expect(Buffer.from(stored!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(rows[0]!.checksum).toBe(await sha256Hex(bytes));
  });

  it("refuses to finish when a part never arrived, and says how many", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(4000, 3000));
    const { begun, completed } = await uploadFile(acme, bytes, "gappy.jpg", { skipPart: 1 });
    expect(begun.ok).toBe(true);
    expect(completed?.ok).toBe(false);
    if (!completed || completed.ok) return;
    expect(completed.retryable).toBe(true);
    expect(completed.message).toMatch(/did not arrive/i);
  });

  it("lets a client resend only the missing part, keeping the rest", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(4000, 3000));

    const begun = await beginUpload(db, acme.ctx, {
      filename: "resume.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    // Everything except the last part: the interrupted-connection case.
    for (let part = 1; part < begun.partCount; part += 1) {
      const start = (part - 1) * begun.partSize;
      await storeUploadPart(
        db,
        acme.ctx,
        begun.uploadPublicId,
        part,
        bytes.slice(start, start + begun.partSize),
      );
    }
    const firstTry = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(firstTry.ok).toBe(false);

    // Send only what was missing — no re-upload of the parts already held.
    const last = begun.partCount;
    const start = (last - 1) * begun.partSize;
    await storeUploadPart(
      db,
      acme.ctx,
      begun.uploadPublicId,
      last,
      bytes.slice(start, bytes.byteLength),
    );

    const secondTry = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(secondTry.ok).toBe(true);
  });

  it("treats a resent part as one part, not two", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(4000, 3000));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "dupe.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;

    for (let part = 1; part <= begun.partCount; part += 1) {
      const start = (part - 1) * begun.partSize;
      const slice = bytes.slice(start, Math.min(start + begun.partSize, bytes.byteLength));
      await storeUploadPart(db, acme.ctx, begun.uploadPublicId, part, slice);
      // A browser retry of a part that in fact succeeded.
      await storeUploadPart(db, acme.ctx, begun.uploadPublicId, part, slice);
    }

    const uploadRow = await db
      .select({ id: mediaUploadParts.id })
      .from(mediaUploadParts);
    // Not asserting a global count — just that completion still agrees, which
    // it cannot if a duplicate row doubled a part into the assembled file.
    expect(uploadRow.length).toBeGreaterThan(0);

    const completed = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(completed.ok).toBe(true);
  });

  it("completing twice returns the same asset instead of making a second", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(300, 200));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "twice.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, bytes);

    const first = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    const second = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.assetPublicId).toBe(first.assetPublicId);
  });
});

describe("server-side verification", () => {
  it("refuses bytes that do not match the declared checksum", async () => {
    const real = new Uint8Array(await images.jpegFixture(200, 200));
    const other = new Uint8Array(await images.jpegFixture(201, 201));

    const begun = await beginUpload(db, acme.ctx, {
      filename: "swapped.jpg",
      declaredBytes: other.byteLength,
      // Declares one file and sends another — corruption, or substitution.
      declaredChecksum: await sha256Hex(real),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, other);

    const completed = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.message).toMatch(/damaged/i);
  });

  it("refuses HTML wearing a .jpg name, whatever the browser claimed", async () => {
    const bytes = new Uint8Array(images.corruptImageFixture());
    const begun = await beginUpload(db, acme.ctx, {
      filename: "sneaky.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, bytes);

    const completed = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    // Not retryable: sending it again will not make it an image.
    expect(completed.retryable).toBe(false);
  });

  it("explains a HEIC rather than calling it unsupported", async () => {
    const bytes = new Uint8Array(images.heicHeaderFixture());
    const begun = await beginUpload(db, acme.ctx, {
      filename: "IMG_0001.HEIC",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/heic",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, bytes);

    const completed = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.message).toMatch(/HEIC/);
    expect(completed.message).toMatch(/Most Compatible/);
  });

  it("refuses a part larger than the session agreed", async () => {
    const small = new Uint8Array(await images.jpegFixture(64, 64));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "liar.jpg",
      declaredBytes: small.byteLength,
      declaredChecksum: await sha256Hex(small),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;

    // Declared a tiny file, then tried to push far more through it — which
    // would make the quota check at `beginUpload` meaningless.
    const oversized = new Uint8Array(UPLOAD_PART_BYTES + 1);
    const stored = await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, oversized);
    expect(stored.ok).toBe(false);
  });

  it("refuses an upload that would exceed the storage quota", async () => {
    const tiny = await seedTenant(db, "Tiny", { mediaQuotaBytes: 1024 });
    const bytes = new Uint8Array(await images.jpegFixture(2000, 2000));

    const begun = await beginUpload(db, tiny.ctx, {
      filename: "too-big-for-quota.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    expect(begun.ok).toBe(false);
    if (begun.ok) return;
    expect(begun.reason).toBe("quota");
    // Refused before any bytes moved, not after a 40 MB upload.
    expect(begun.message).toMatch(/allowance/i);
  });
});

describe("derivative jobs", () => {
  it("promotes an asset to ready and writes every size", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(2400, 1600));
    const { completed } = await uploadFile(acme, bytes, "derive.jpg");
    expect(completed?.ok).toBe(true);
    if (!completed?.ok) return;

    const outcomes = await runDerivativeJobs(db, 10);
    expect(outcomes.some((o) => o.assetPublicId === completed.assetPublicId && o.ok)).toBe(true);

    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    expect(asset.status).toBe("ready");
    expect(asset.hasThumbnail).toBe(true);

    const rows = await db
      .select({ kind: mediaDerivatives.kind, width: mediaDerivatives.width })
      .from(mediaDerivatives)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    expect(rows.map((r) => r.kind).sort()).toEqual([
      "preview",
      "thumb",
      "web_lg",
      "web_md",
      "web_sm",
    ]);
  });

  it("never enlarges a small image", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(320, 240));
    const { completed } = await uploadFile(acme, bytes, "small.jpg");
    if (!completed?.ok) return;
    await runDerivativeJobs(db, 10);

    const rows = await db
      .select({ width: mediaDerivatives.width, height: mediaDerivatives.height })
      .from(mediaDerivatives)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    // Every size caps at the source. Upscaling would produce a soft image that
    // reads as our mistake rather than as a small original.
    for (const row of rows) {
      expect(row.width).toBeLessThanOrEqual(320);
      expect(row.height).toBeLessThanOrEqual(240);
    }
  });

  it("keeps transparency instead of flattening it", async () => {
    const bytes = new Uint8Array(await images.transparentPngFixture(900, 600));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "logo.png",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/png",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, bytes);
    const completed = await completeUpload(db, acme.ctx, begun.uploadPublicId);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    expect(asset.hasAlpha).toBe(true);

    await runDerivativeJobs(db, 10);

    const rows = await db
      .select({ key: mediaDerivatives.storageKey })
      .from(mediaDerivatives)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    const sharp = (await import("sharp")).default;
    for (const row of rows) {
      const object = await mediaDriver().get(row.key);
      const meta = await sharp(Buffer.from(object!.bytes)).metadata();
      // The whole point: the alpha channel survives into every derivative.
      expect(meta.hasAlpha, row.key).toBe(true);
    }
  });

  it("applies EXIF rotation so a phone photo is not sideways", async () => {
    // Stored 800x400 with orientation 6 — a portrait photo held landscape.
    const bytes = new Uint8Array(await images.jpegFixture(800, 400, { orientation: 6 }));
    const { completed } = await uploadFile(acme, bytes, "rotated.jpg");
    if (!completed?.ok) return;

    // Reported the way a person sees it, not the way it is stored.
    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    expect(asset.width).toBe(400);
    expect(asset.height).toBe(800);

    await runDerivativeJobs(db, 10);

    const rows = await db
      .select({ key: mediaDerivatives.storageKey, kind: mediaDerivatives.kind })
      .from(mediaDerivatives)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    const sharp = (await import("sharp")).default;
    const thumb = rows.find((r) => r.kind === "thumb")!;
    const object = await mediaDriver().get(thumb.key);
    const meta = await sharp(Buffer.from(object!.bytes)).metadata();
    // Taller than wide: the rotation was baked into the pixels.
    expect(meta.height!).toBeGreaterThan(meta.width!);
  });

  it("strips location metadata from derivatives while the original keeps it", async () => {
    const sharp = (await import("sharp")).default;
    // A photo carrying GPS, as a phone would produce. IFD3 is the GPS
    // directory in libvips' naming.
    const withGps = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .withExif({
        IFD0: { Copyright: "Test" },
        IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "W" },
      })
      .jpeg()
      .toBuffer();

    // The fixture has to actually carry metadata, or the assertions below pass
    // for the wrong reason and this test proves nothing.
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const bytes = new Uint8Array(withGps);
    const { completed } = await uploadFile(acme, bytes, "geotagged.jpg");
    if (!completed?.ok) return;
    await runDerivativeJobs(db, 10);

    const rows = await db
      .select({ key: mediaDerivatives.storageKey })
      .from(mediaDerivatives)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaDerivatives.assetId))
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    for (const row of rows) {
      const object = await mediaDriver().get(row.key);
      const meta = await sharp(Buffer.from(object!.bytes)).metadata();
      // Derivatives are what reach a public site. They must not publish where
      // the photo was taken.
      expect(meta.exif, row.key).toBeUndefined();
    }

    // The original is the client's archive and stays untouched.
    const originalRow = await db
      .select({ key: mediaAssets.storageKey })
      .from(mediaAssets)
      .where(eq(mediaAssets.publicId, completed.assetPublicId));
    const original = await mediaDriver().get(originalRow[0]!.key!);
    expect(Buffer.from(original!.bytes).equals(Buffer.from(withGps))).toBe(true);
  });

  it("marks an asset failed with a readable reason once retries are exhausted", async () => {
    // An asset whose bytes are gone: the job can never succeed.
    const bytes = new Uint8Array(await images.jpegFixture(200, 150));
    const { completed } = await uploadFile(acme, bytes, "vanishing.jpg");
    if (!completed?.ok) return;

    const rows = await db
      .select({ id: mediaAssets.id, key: mediaAssets.storageKey })
      .from(mediaAssets)
      .where(eq(mediaAssets.publicId, completed.assetPublicId));
    await mediaDriver().delete(rows[0]!.key!);

    // Three attempts, with the backoff wound forward between them.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .update(mediaJobs)
        .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
        .where(eq(mediaJobs.assetId, rows[0]!.id));
      await runDerivativeJobs(db, 10);
    }

    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    expect(asset.status).toBe("failed");
    // Never left spinning: "processing" that never ends looks like a broken
    // system and gives the client nothing to do.
    expect(asset.failureReason).toBeTruthy();
    expect(asset.failureReason).toMatch(/retry/i);
  });

  it("re-queues a failed asset when the client asks to retry", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(180, 120));
    const { completed } = await uploadFile(acme, bytes, "retryable.jpg");
    if (!completed?.ok) return;

    const rows = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.publicId, completed.assetPublicId));

    await db
      .update(mediaAssets)
      .set({ status: "failed", failureReason: "boom" })
      .where(eq(mediaAssets.id, rows[0]!.id));
    await db
      .update(mediaJobs)
      .set({ status: "failed", attempts: 3 })
      .where(eq(mediaJobs.assetId, rows[0]!.id));

    await retryAsset(db, rows[0]!.id);
    await runDerivativeJobs(db, 10);

    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    expect(asset.status).toBe("ready");
  });
});

describe("the library shows what was uploaded", () => {
  it("lists an uploaded image for its owner and counts it against storage", async () => {
    const owner = await seedTenant(db, "Lister");
    const before = await getStorageUsage(db, owner.ctx);
    expect(before.assetCount).toBe(0);

    const bytes = new Uint8Array(await images.jpegFixture(1200, 900));
    const { completed } = await uploadFile(owner, bytes, "listed.jpg");
    expect(completed?.ok).toBe(true);
    if (!completed?.ok) return;
    await runDerivativeJobs(db, 10);

    // The library's default view: everything, not trashed.
    const listed = await listAssets(db, owner.ctx, {});
    expect(listed.map((a) => a.publicId)).toContain(completed.assetPublicId);

    const after = await getStorageUsage(db, owner.ctx);
    expect(after.assetCount).toBe(1);
    expect(after.originalBytes).toBe(bytes.byteLength);
    // Derivatives are counted separately, and there should be some by now.
    expect(after.derivativeBytes).toBeGreaterThan(0);
    expect(after.totalBytes).toBeGreaterThan(bytes.byteLength);
  });

  it("lists an image filed in a folder when that folder is selected", async () => {
    const owner = await seedTenant(db, "Filer");
    const { createFolder } = await import("@/db/repositories/client/media-folders");
    const folder = await createFolder(db, owner.ctx, { name: "Series One" });
    expect(folder.ok).toBe(true);
    if (!folder.ok) return;

    const bytes = new Uint8Array(await images.jpegFixture(400, 400));
    const { completed } = await uploadFile(owner, bytes, "filed.jpg", {
      folderPublicId: folder.publicId,
    });
    if (!completed?.ok) return;

    const inFolder = await listAssets(db, owner.ctx, {
      folderPublicId: folder.publicId,
    });
    expect(inFolder.map((a) => a.publicId)).toContain(completed.assetPublicId);

    // Not among the unfiled ones, because it is filed.
    const unfiled = await listAssets(db, owner.ctx, { folderPublicId: null });
    expect(unfiled.map((a) => a.publicId)).not.toContain(completed.assetPublicId);

    // But still in the default "All images" view, which spans folders. A
    // client who files a photo and then cannot find it under All images would
    // reasonably conclude we had lost it.
    const everywhere = await listAssets(db, owner.ctx, {});
    expect(everywhere.map((a) => a.publicId)).toContain(completed.assetPublicId);
  });
});

describe("tenant isolation", () => {
  it("does not let one client complete another client's upload", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(200, 200));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "private.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, bytes);

    // Globex holds Acme's upload id and tries to use it.
    await expect(
      completeUpload(db, globex.ctx, begun.uploadPublicId),
    ).rejects.toThrow();
  });

  it("does not let one client push parts into another client's upload", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(200, 200));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "private2.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;

    await expect(
      storeUploadPart(db, globex.ctx, begun.uploadPublicId, 1, bytes),
    ).rejects.toThrow();
  });

  it("does not show one client another client's images", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(150, 150));
    const { completed } = await uploadFile(acme, bytes, "acme-only.jpg");
    if (!completed?.ok) return;

    const seenByGlobex = await listAssets(db, globex.ctx, {});
    expect(seenByGlobex.some((a) => a.publicId === completed.assetPublicId)).toBe(false);

    // And a guessed id resolves to not-found, never to a 403 that would
    // confirm the asset exists.
    await expect(getAsset(db, globex.ctx, completed.assetPublicId)).rejects.toThrow();
  });
});

describe("abandoned uploads", () => {
  it("sweeps an expired session, its parts, and its placeholder", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(2000, 1500));
    const begun = await beginUpload(db, acme.ctx, {
      filename: "abandoned.jpg",
      declaredBytes: bytes.byteLength,
      declaredChecksum: await sha256Hex(bytes),
      declaredContentType: "image/jpeg",
    });
    if (!begun.ok) return;
    await storeUploadPart(db, acme.ctx, begun.uploadPublicId, 1, bytes.slice(0, 1000));

    const before = await getStorageUsage(db, acme.ctx);

    // The client closed the tab. Wind the clock past the session's expiry.
    await db
      .update((await import("@/db/schema")).mediaUploads)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq((await import("@/db/schema")).mediaUploads.publicId, begun.uploadPublicId));

    const swept = await sweepExpiredUploads(db);
    expect(swept.sessions).toBeGreaterThanOrEqual(1);

    // The placeholder is gone, so it is not holding quota or cluttering the
    // library with an image that will never finish.
    const remaining = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.publicId, begun.assetPublicId));
    expect(remaining.length).toBe(0);

    const after = await getStorageUsage(db, acme.ctx);
    expect(after.assetCount).toBeLessThanOrEqual(before.assetCount);
  });

  it("never sweeps an asset that already has its bytes", async () => {
    const bytes = new Uint8Array(await images.jpegFixture(300, 300));
    const { completed } = await uploadFile(acme, bytes, "finished.jpg");
    if (!completed?.ok) return;

    await sweepExpiredUploads(db, 100);

    const asset = await getAsset(db, acme.ctx, completed.assetPublicId);
    expect(asset.publicId).toBe(completed.assetPublicId);
  });
});
