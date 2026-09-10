import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { mediaAssets } from "@/db/schema";
import { beginUpload, storeUploadPart } from "@/db/repositories/client/media-uploads";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";
import * as images from "./helpers/images";
import * as driver from "@/lib/storage/driver";

/**
 * When the object store refuses.
 *
 * Nine uploads in production created nine sessions and stored zero parts. The
 * write to Netlify Blobs was failing on every call, and every one of those
 * assets is still sitting at `uploading` — a tile that reads "Preparing…" and
 * never will. The exception went to a function log nobody could read, so from
 * the outside an unavailable object store and a slow one look the same.
 *
 * `media_assets.failure_reason` has existed since the library shipped and
 * nothing ever wrote to it. These tests are the contract that it does now: a
 * storage failure marks the asset failed, records why, and answers the client
 * instead of throwing past every handler into an HTML error page.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await seedTenant(db, "Acme");
});

afterAll(async () => {
  await close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An object store that is there, and refuses. */
function breakStorage(message: string) {
  vi.spyOn(driver, "mediaDriver").mockReturnValue({
    put: async () => {
      throw new TypeError(message);
    },
    get: async () => null,
    delete: async () => {},
  } as never);
}

/** Same helper `media-upload.test.ts` uses; there is no shared export. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function startUpload() {
  const bytes = new Uint8Array(await images.jpegFixture(64, 64));
  const started = await beginUpload(db, acme.ctx, {
    filename: "hero.jpg",
    declaredBytes: bytes.byteLength,
    declaredChecksum: await sha256Hex(bytes),
    declaredContentType: "image/jpeg",
    folderPublicId: null,
  });
  if (!started.ok) throw new Error(`could not begin: ${started.message}`);
  return { started, bytes };
}

async function assetOf(publicId: string) {
  const rows = await db
    .select({
      status: mediaAssets.status,
      failureReason: mediaAssets.failureReason,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.publicId, publicId));
  return rows[0]!;
}

describe("a part that cannot be written to storage", () => {
  it("answers the client instead of throwing", async () => {
    const { started, bytes } = await startUpload();
    breakStorage("store.set is not a function");

    // Throwing here is what produced Next's HTML error page, which the
    // uploader could not parse — so it reported a dropped connection.
    const result = await storeUploadPart(
      db,
      acme.ctx,
      started.uploadPublicId,
      1,
      bytes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/could not save that part/i);
  });

  it("marks the asset failed rather than leaving it Preparing for ever", async () => {
    const { started, bytes } = await startUpload();
    breakStorage("fetch failed");

    await storeUploadPart(db, acme.ctx, started.uploadPublicId, 1, bytes);

    const asset = await assetOf(started.assetPublicId);
    expect(asset.status).toBe("failed");
  });

  it("records why, so the cause is legible without a function log", async () => {
    const { started, bytes } = await startUpload();
    breakStorage("MissingBlobsEnvironmentError: siteID is unset");

    await storeUploadPart(db, acme.ctx, started.uploadPublicId, 1, bytes);

    const asset = await assetOf(started.assetPublicId);
    expect(asset.failureReason).toContain("MissingBlobsEnvironmentError");
    expect(asset.failureReason).toContain("siteID is unset");
  });

  it("bounds what it stores, so a stack cannot fill the column", async () => {
    const { started, bytes } = await startUpload();
    breakStorage("x".repeat(5000));

    await storeUploadPart(db, acme.ctx, started.uploadPublicId, 1, bytes);

    const asset = await assetOf(started.assetPublicId);
    expect(asset.failureReason!.length).toBeLessThanOrEqual(500);
  });

  it("leaves a working upload untouched", async () => {
    const { started, bytes } = await startUpload();

    const result = await storeUploadPart(
      db,
      acme.ctx,
      started.uploadPublicId,
      1,
      bytes,
    );

    expect(result.ok).toBe(true);
    const asset = await assetOf(started.assetPublicId);
    expect(asset.status).not.toBe("failed");
    expect(asset.failureReason).toBeNull();
  });
});
