import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  clients,
  mediaAssets,
  mediaDerivatives,
  requestAssets,
} from "@/db/schema";
import { createChangeRequest } from "@/db/repositories/client/change-requests";
import { attachAssetsToRequest } from "@/db/repositories/client/request-assets";
import { newPublicId } from "@/lib/ids";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * Deleting photos for good, to free space.
 *
 * Deleting a photo moved it to the trash and nothing ever emptied the trash:
 * the bytes stayed, they still counted against the client's storage, and the
 * library told a client near their limit that "emptying the trash frees space"
 * with no way to do it.
 *
 * Still two steps — delete moves to the trash, and only the trash offers
 * "delete forever" — because the cost of keeping bytes someone meant to
 * discard is storage, and the cost of the other mistake is the only copy of a
 * painting.
 */

const deleted: string[] = [];
const failing = new Set<string>();

vi.mock("@/lib/storage/driver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/driver")>();
  return {
    ...actual,
    storageDriver: () => ({
      put: async () => {
        throw new Error("not used here");
      },
      get: async () => null,
      delete: async (key: string) => {
        if (failing.has(key)) throw new Error("storage unavailable");
        deleted.push(key);
      },
    }),
  };
});

const { purgeAssets, trashAssets, getStorageUsage } = await import(
  "@/db/repositories/client/media-assets"
);

const ORIGINAL_BYTES = 2048;
const DERIVATIVE_BYTES = 512;

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

async function photo(
  tenant: SeededTenant,
  { trashed = true }: { trashed?: boolean } = {},
): Promise<{ publicId: string; original: string; thumb: string }> {
  const publicId = newPublicId();
  const original = `a/${publicId}/original.jpg`;
  const thumb = `a/${publicId}/thumb.webp`;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      publicId,
      organizationId: tenant.organizationId,
      status: "ready",
      storageKey: original,
      originalFilename: `${publicId.slice(0, 6)}.jpg`,
      contentType: "image/jpeg",
      byteSize: ORIGINAL_BYTES,
      checksumSha256: "c".repeat(64),
      width: 1600,
      height: 1200,
      orientation: 1,
      deletedAt: trashed ? new Date() : null,
    })
    .returning({ id: mediaAssets.id });
  await db.insert(mediaDerivatives).values({
    assetId: row!.id,
    kind: "thumb",
    storageKey: thumb,
    contentType: "image/webp",
    width: 320,
    height: 240,
    byteSize: DERIVATIVE_BYTES,
  });
  return { publicId, original, thumb };
}

async function reserved(tenant: SeededTenant): Promise<number> {
  const rows = await db
    .select({ bytes: clients.mediaReservedBytes })
    .from(clients)
    .where(eq(clients.id, tenant.clientId));
  return Number(rows[0]!.bytes);
}

async function stillThere(publicIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ publicId: mediaAssets.publicId })
    .from(mediaAssets)
    .where(inArray(mediaAssets.publicId, publicIds));
  return rows.map((r) => r.publicId);
}

/** A request using the photo, at the given point in its life. */
async function usedBy(tenant: SeededTenant, assetPublicId: string, status: string, title = "Hero photo") {
  const request = await createChangeRequest(db, tenant.ctx, { title });
  await attachAssetsToRequest(db, tenant.ctx, request.id, [assetPublicId]);
  await db
    .update(changeRequests)
    .set({ status: status as never })
    .where(eq(changeRequests.id, request.id));
  return request;
}

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  close = created.close;
  acme = await seedTenant(db, "Acme");
  globex = await seedTenant(db, "Globex");
});

afterAll(async () => close());

beforeEach(async () => {
  deleted.length = 0;
  failing.clear();
  await db.delete(requestAssets);
  await db.delete(changeRequests);
  await db.delete(mediaAssets);
  // As if every byte above were reserved, so a release shows up as a drop.
  await db.update(clients).set({ mediaReservedBytes: 100_000 });
});

describe("deleting photos for good", () => {
  it("removes a trashed photo's files and record, and gives back its space", async () => {
    const p = await photo(acme);

    const outcome = await purgeAssets(db, acme.ctx, [p.publicId]);

    expect(outcome.ok).toBe(true);
    expect(outcome.purged).toBe(1);
    expect(deleted.sort()).toEqual([p.original, p.thumb].sort());
    expect(await stillThere([p.publicId])).toEqual([]);
    expect(outcome.freedBytes).toBe(ORIGINAL_BYTES + DERIVATIVE_BYTES);
    expect(await reserved(acme)).toBe(100_000 - ORIGINAL_BYTES - DERIVATIVE_BYTES);

    const usage = await getStorageUsage(db, acme.ctx);
    expect(usage.trashedBytes).toBe(0);
  });

  it("empties the whole trash when no photo is named, and leaves the library alone", async () => {
    const a = await photo(acme);
    const b = await photo(acme);
    const live = await photo(acme, { trashed: false });

    const outcome = await purgeAssets(db, acme.ctx);

    expect(outcome.purged).toBe(2);
    expect(await stillThere([a.publicId, b.publicId, live.publicId])).toEqual([live.publicId]);
  });

  it("never deletes a photo that is not in the trash", async () => {
    const live = await photo(acme, { trashed: false });

    const outcome = await purgeAssets(db, acme.ctx, [live.publicId]);

    expect(outcome.ok).toBe(false);
    expect(deleted).toEqual([]);
    expect(await stillThere([live.publicId])).toEqual([live.publicId]);
  });

  it("keeps a photo a change in progress still needs, and says which change", async () => {
    const p = await photo(acme, { trashed: false });
    await usedBy(acme, p.publicId, "dispatched", "New hero photo");
    await db.update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.publicId, p.publicId));

    const outcome = await purgeAssets(db, acme.ctx, [p.publicId]);

    expect(outcome.ok).toBe(false);
    expect(outcome.kept).toEqual([p.publicId]);
    expect(outcome.message).toMatch(/New hero photo/);
    expect(deleted).toEqual([]);
  });

  it("deletes a photo once the change that used it is finished — the site keeps its own copy", async () => {
    const p = await photo(acme, { trashed: false });
    const request = await usedBy(acme, p.publicId, "verified");
    await db.update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.publicId, p.publicId));

    const outcome = await purgeAssets(db, acme.ctx, [p.publicId]);

    expect(outcome.purged).toBe(1);
    expect(await stillThere([p.publicId])).toEqual([]);
    // The request itself, and its history, stay.
    const rows = await db.select().from(changeRequests).where(eq(changeRequests.id, request.id));
    expect(rows).toHaveLength(1);
  });

  it("leaves a photo in the trash when its files could not be removed", async () => {
    const p = await photo(acme);
    failing.add(p.original);

    const outcome = await purgeAssets(db, acme.ctx, [p.publicId]);

    expect(outcome.ok).toBe(false);
    expect(outcome.failed).toBe(1);
    // Still listed and still counted: a record pointing at nothing would hide
    // bytes that may still be there.
    expect(await stillThere([p.publicId])).toEqual([p.publicId]);
    expect(await reserved(acme)).toBe(100_000);
  });

  it("cannot reach another client's trash", async () => {
    const theirs = await photo(acme);

    const outcome = await purgeAssets(db, globex.ctx, [theirs.publicId]);
    await purgeAssets(db, globex.ctx);

    expect(outcome.purged).toBe(0);
    expect(deleted).toEqual([]);
    expect(await stillThere([theirs.publicId])).toEqual([theirs.publicId]);
  });
});

describe("moving photos to the trash", () => {
  it("allows a photo from a change that is already live", async () => {
    const p = await photo(acme, { trashed: false });
    await usedBy(acme, p.publicId, "merged");

    const outcome = await trashAssets(db, acme.ctx, [p.publicId]);

    expect(outcome.ok).toBe(true);
  });

  it("still keeps one a change in progress needs", async () => {
    const p = await photo(acme, { trashed: false });
    await usedBy(acme, p.publicId, "pr_open");

    const outcome = await trashAssets(db, acme.ctx, [p.publicId]);

    expect(outcome.ok).toBe(false);
  });
});
