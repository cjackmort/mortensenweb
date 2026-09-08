import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { mediaFolders } from "@/db/schema";
import {
  createFolder,
  deleteFolder,
  listFolders,
  moveFolder,
  renameFolder,
} from "@/db/repositories/client/media-folders";
import { createTestDb } from "./helpers/db";
import { seedTenant, type SeededTenant } from "./helpers/tenant";

/**
 * The folder tree.
 *
 * The cases here are the ones that corrupt a tree rather than merely annoy a
 * user: a cycle, a move that outruns the depth limit partway through, and a
 * rename that forgets the descendants. Each of those leaves data that no query
 * in the repository would report as wrong.
 */

let db: Database;
let close: () => Promise<void>;
let acme: SeededTenant;
let globex: SeededTenant;

async function makeFolder(
  tenant: SeededTenant,
  name: string,
  parent?: string | null,
): Promise<string> {
  const result = await createFolder(db, tenant.ctx, { name, parentPublicId: parent ?? null });
  expect(result.ok, `creating ${name}`).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.publicId;
}

async function pathOf(publicId: string): Promise<string> {
  const rows = await db
    .select({ path: mediaFolders.path })
    .from(mediaFolders)
    .where(eq(mediaFolders.publicId, publicId));
  return rows[0]!.path;
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
});

describe("creating folders", () => {
  it("nests subfolders and records their paths", async () => {
    const artwork = await makeFolder(acme, "Artwork");
    const year = await makeFolder(acme, "2026", artwork);
    const series = await makeFolder(acme, "Winter Series", year);

    expect(await pathOf(artwork)).toBe("/artwork");
    expect(await pathOf(year)).toBe("/artwork/2026");
    expect(await pathOf(series)).toBe("/artwork/2026/winter series");
  });

  it("refuses a duplicate name beside its sibling", async () => {
    await makeFolder(acme, "Prints");
    const again = await createFolder(db, acme.ctx, { name: "Prints" });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.message).toMatch(/already a folder/i);
  });

  it("allows the same name in a different parent", async () => {
    const a = await makeFolder(acme, "Alpha");
    const b = await makeFolder(acme, "Beta");
    await makeFolder(acme, "Drafts", a);
    // Same name, different parent: a distinct path, so it is allowed.
    const second = await createFolder(db, acme.ctx, {
      name: "Drafts",
      parentPublicId: b,
    });
    expect(second.ok).toBe(true);
  });

  it("treats names as case-insensitive for uniqueness", async () => {
    await makeFolder(acme, "Sketches");
    const shouty = await createFolder(db, acme.ctx, { name: "SKETCHES" });
    // Two folders whose names differ only in case are indistinguishable in a
    // sidebar, and a client would rightly call that a bug.
    expect(shouty.ok).toBe(false);
  });

  it("refuses a name containing a slash", async () => {
    const result = await createFolder(db, acme.ctx, { name: "2026/Spring" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/slashes/i);
  });

  it("refuses a blank name", async () => {
    expect((await createFolder(db, acme.ctx, { name: "   " })).ok).toBe(false);
  });

  it("refuses nesting past the depth limit", async () => {
    let parent: string | null = null;
    for (let level = 0; level <= 10; level += 1) {
      const result = await createFolder(db, acme.ctx, {
        name: `deep-${level}`,
        parentPublicId: parent,
      });
      if (level <= 10 - 1) {
        expect(result.ok, `level ${level}`).toBe(true);
      }
      if (!result.ok) {
        expect(result.message).toMatch(/nested/i);
        return;
      }
      parent = result.publicId;
    }
    // Level 11 must have been refused before we got here.
    const overflow = await createFolder(db, acme.ctx, {
      name: "one-too-deep",
      parentPublicId: parent,
    });
    expect(overflow.ok).toBe(false);
  });
});

describe("the sidebar counts", () => {
  it("counts the ready images in each folder", async () => {
    const { mediaAssets } = await import("@/db/schema");
    const { newPublicId } = await import("@/lib/ids");

    const counted = await makeFolder(acme, "Counted");
    const empty = await makeFolder(acme, "Empty");
    const folderRow = await db
      .select({ id: mediaFolders.id })
      .from(mediaFolders)
      .where(eq(mediaFolders.publicId, counted));

    async function put(status: "ready" | "processing", deleted = false) {
      const publicId = newPublicId();
      await db.insert(mediaAssets).values({
        publicId,
        organizationId: acme.organizationId,
        folderId: folderRow[0]!.id,
        status,
        storageKey: `a/${publicId}/original.jpg`,
        originalFilename: `${publicId}.jpg`,
        contentType: "image/jpeg",
        byteSize: 10,
        checksumSha256: "d".repeat(64),
        deletedAt: deleted ? new Date() : null,
      });
    }

    await put("ready");
    await put("ready");
    // Neither of these should be counted: one is not usable yet, the other is
    // in the trash. A count that included them would offer the client images
    // they cannot actually use.
    await put("processing");
    await put("ready", true);

    const listed = await listFolders(db, acme.ctx);
    const countedNode = listed.find((f) => f.publicId === counted);
    const emptyNode = listed.find((f) => f.publicId === empty);

    // This assertion is the whole point of the test. The original
    // implementation used a correlated subquery whose interpolated column
    // rendered as a bare `"id"`, binding to `media_assets` instead of
    // `media_folders` — so every folder reported zero, and nothing errored.
    expect(countedNode?.assetCount).toBe(2);

    // And an empty folder still appears, rather than being dropped by the join.
    expect(emptyNode).toBeDefined();
    expect(emptyNode?.assetCount).toBe(0);
  });

  it("reports each folder's parent", async () => {
    const top = await makeFolder(acme, "Parented Top");
    const child = await makeFolder(acme, "Parented Child", top);

    const listed = await listFolders(db, acme.ctx);
    const childNode = listed.find((f) => f.publicId === child);
    const topNode = listed.find((f) => f.publicId === top);

    // The sidebar's indentation depends on this, and the same bare-identifier
    // fault made it always null.
    expect(childNode?.parentPublicId).toBe(top);
    expect(topNode?.parentPublicId).toBeNull();
  });
});

describe("renaming", () => {
  it("rewrites the paths of every descendant", async () => {
    const root = await makeFolder(acme, "Portfolio");
    const child = await makeFolder(acme, "Oils", root);
    const grandchild = await makeFolder(acme, "Large", child);

    const renamed = await renameFolder(db, acme.ctx, root, "Gallery");
    expect(renamed.ok).toBe(true);

    // A rename that updates only the folder leaves every descendant pointing
    // at a path that no longer exists — and nothing would report it.
    expect(await pathOf(root)).toBe("/gallery");
    expect(await pathOf(child)).toBe("/gallery/oils");
    expect(await pathOf(grandchild)).toBe("/gallery/oils/large");
  });

  it("does not rewrite a sibling that merely shares a prefix", async () => {
    const shortName = await makeFolder(acme, "Art");
    const longName = await makeFolder(acme, "Artichokes");

    await renameFolder(db, acme.ctx, shortName, "Artworks");

    // `/art` renamed must not drag `/artichokes` with it. A textual prefix
    // replace would have done exactly that.
    expect(await pathOf(shortName)).toBe("/artworks");
    expect(await pathOf(longName)).toBe("/artichokes");
  });

  it("refuses a rename that collides with a sibling", async () => {
    const parent = await makeFolder(acme, "Collections");
    await makeFolder(acme, "One", parent);
    const two = await makeFolder(acme, "Two", parent);

    const clash = await renameFolder(db, acme.ctx, two, "One");
    expect(clash.ok).toBe(false);
  });
});

describe("moving", () => {
  it("moves a subtree and shifts its depth", async () => {
    const source = await makeFolder(acme, "Source");
    const leaf = await makeFolder(acme, "Leaf", source);
    const destination = await makeFolder(acme, "Destination");

    const moved = await moveFolder(db, acme.ctx, source, destination);
    expect(moved.ok).toBe(true);

    expect(await pathOf(source)).toBe("/destination/source");
    expect(await pathOf(leaf)).toBe("/destination/source/leaf");

    const rows = await db
      .select({ depth: mediaFolders.depth })
      .from(mediaFolders)
      .where(eq(mediaFolders.publicId, leaf));
    expect(rows[0]!.depth).toBe(2);
  });

  it("refuses to move a folder into itself", async () => {
    const self = await makeFolder(acme, "Selfish");
    const result = await moveFolder(db, acme.ctx, self, self);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/inside itself/i);
  });

  it("refuses to move a folder into its own descendant", async () => {
    const top = await makeFolder(acme, "Top");
    const middle = await makeFolder(acme, "Middle", top);
    const bottom = await makeFolder(acme, "Bottom", middle);

    // The cycle case. A tree containing one makes every LIKE traversal either
    // loop or silently return half of itself, with no error anywhere.
    const result = await moveFolder(db, acme.ctx, top, bottom);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/subfolder/i);

    // And nothing moved.
    expect(await pathOf(top)).toBe("/top");
    expect(await pathOf(bottom)).toBe("/top/middle/bottom");
  });

  it("moves a folder to the root", async () => {
    const parent = await makeFolder(acme, "Parent");
    const child = await makeFolder(acme, "Child", parent);

    expect((await moveFolder(db, acme.ctx, child, null)).ok).toBe(true);
    expect(await pathOf(child)).toBe("/child");
  });

  it("refuses a move that would push a descendant past the depth limit", async () => {
    // A three-level stack, and a destination deep enough that moving the stack
    // under it would overflow. Checking only the moved folder's own depth would
    // pass here and then fail partway through the subtree rewrite.
    let deep: string | null = null;
    for (let level = 0; level < 9; level += 1) {
      deep = await makeFolder(acme, `chain-${level}`, deep);
    }

    const stackTop = await makeFolder(acme, "stack-top");
    const stackMid = await makeFolder(acme, "stack-mid", stackTop);
    await makeFolder(acme, "stack-leaf", stackMid);

    const result = await moveFolder(db, acme.ctx, stackTop, deep);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/deep/i);
    // Unmoved, rather than half-moved.
    expect(await pathOf(stackTop)).toBe("/stack-top");
  });
});

describe("deleting", () => {
  it("keeps the images and releases them to the root", async () => {
    const folder = await makeFolder(acme, "Temporary");
    const { mediaAssets } = await import("@/db/schema");
    const { newPublicId } = await import("@/lib/ids");

    const folderRow = await db
      .select({ id: mediaFolders.id })
      .from(mediaFolders)
      .where(eq(mediaFolders.publicId, folder));

    const assetPublicId = newPublicId();
    await db.insert(mediaAssets).values({
      publicId: assetPublicId,
      organizationId: acme.organizationId,
      folderId: folderRow[0]!.id,
      status: "ready",
      storageKey: `a/${assetPublicId}/original.jpg`,
      originalFilename: "kept.jpg",
      contentType: "image/jpeg",
      byteSize: 100,
      checksumSha256: "a".repeat(64),
    });

    const deleted = await deleteFolder(db, acme.ctx, folder);
    expect(deleted.ok).toBe(true);
    expect(deleted.releasedAssets).toBe(1);
    expect(deleted.message).toMatch(/All images/);

    // The artwork survives its folder. This is the whole point.
    const survivor = await db
      .select({ folderId: mediaAssets.folderId, id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.publicId, assetPublicId));
    expect(survivor.length).toBe(1);
    expect(survivor[0]!.folderId).toBeNull();
  });

  it("removes the subtree from the listing", async () => {
    const parent = await makeFolder(acme, "Doomed");
    await makeFolder(acme, "AlsoDoomed", parent);

    await deleteFolder(db, acme.ctx, parent);

    const listed = await listFolders(db, acme.ctx);
    expect(listed.some((f) => f.publicId === parent)).toBe(false);
    expect(listed.some((f) => f.name === "AlsoDoomed")).toBe(false);
  });

  it("frees the name for reuse", async () => {
    await makeFolder(acme, "Recyclable");
    const first = (await listFolders(db, acme.ctx)).find((f) => f.name === "Recyclable")!;
    await deleteFolder(db, acme.ctx, first.publicId);

    // A client who deletes a folder and makes a new one with the same name
    // must not be told the name is taken by something they cannot see.
    const again = await createFolder(db, acme.ctx, { name: "Recyclable" });
    expect(again.ok).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("does not list another client's folders", async () => {
    await makeFolder(globex, "Globex Only");
    const acmeSees = await listFolders(db, acme.ctx);
    expect(acmeSees.some((f) => f.name === "Globex Only")).toBe(false);
  });

  it("does not let one client rename another client's folder", async () => {
    const theirs = await makeFolder(globex, "Theirs");
    const result = await renameFolder(db, acme.ctx, theirs, "Mine");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Reported as not-found, never as forbidden — a 403 confirms it exists.
    expect(result.message).toMatch(/couldn't find/i);
  });

  it("does not let one client move a folder into another client's tree", async () => {
    const mine = await makeFolder(acme, "MyFolder");
    const theirs = await makeFolder(globex, "TheirFolder");

    const result = await moveFolder(db, acme.ctx, mine, theirs);
    expect(result.ok).toBe(false);
    expect(await pathOf(mine)).toBe("/myfolder");
  });

  it("does not let one client delete another client's folder", async () => {
    const theirs = await makeFolder(globex, "Precious");
    const result = await deleteFolder(db, acme.ctx, theirs);
    expect(result.ok).toBe(false);

    const stillThere = await listFolders(db, globex.ctx);
    expect(stillThere.some((f) => f.publicId === theirs)).toBe(true);
  });
});
