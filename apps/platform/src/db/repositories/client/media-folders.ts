import { and, asc, eq, isNull, like, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/db/client";
import { mediaAssets, mediaFolders } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { MAX_FOLDER_DEPTH, MAX_FOLDER_NAME_LENGTH } from "@/lib/media/constants";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * Folders in the media library, tenant-scoped.
 *
 * Every query filters on `ctx.organizationId`, so a guessed public id from
 * another tenant resolves to `NotFoundError` — indistinguishable from a folder
 * that does not exist, per the 404-not-403 rule.
 *
 * ## Paths, and why they are stored
 *
 * `path` is the materialised lowercase route: `/artwork/2026`. It is derived
 * data and therefore a thing that can go stale, which is a real cost. What it
 * buys:
 *
 *  - **Cycle prevention becomes a string comparison.** Moving A under B is
 *    invalid exactly when B is A or sits beneath A, and `b.path` starting with
 *    `a.path + "/"` answers that without walking any parents.
 *  - **Sibling uniqueness is one index**, not a query the application has to
 *    remember to run.
 *  - **Subtree operations are one statement.** Renaming a folder rewrites its
 *    descendants with a single `UPDATE ... WHERE path LIKE '/old/%'`.
 *
 * The obligation this creates is that *every* write which changes a name or a
 * parent must also rewrite the subtree. There are exactly two such functions —
 * `renameFolder` and `moveFolder` — and both do it.
 *
 * ## Deleting never deletes artwork
 *
 * A trashed folder releases its assets to the library root rather than taking
 * them with it. Someone tidying their folders must not be able to destroy the
 * only copy of a painting by dragging a folder to the bin, so the destructive
 * reading of "delete folder" is simply not implemented.
 */

export interface FolderNode {
  publicId: string;
  name: string;
  path: string;
  depth: number;
  parentPublicId: string | null;
  /** Ready assets directly in this folder. Excludes descendants. */
  assetCount: number;
}

export type FolderMutation =
  | { ok: true; publicId: string }
  | { ok: false; message: string };

/** Lowercased, so `/Artwork` and `/artwork` cannot both exist. */
function pathSegment(name: string): string {
  return name.trim().toLowerCase();
}

function childPath(parentPath: string | null, name: string): string {
  const segment = pathSegment(name);
  return parentPath && parentPath !== "/"
    ? `${parentPath}/${segment}`
    : `/${segment}`;
}

/**
 * Names are stored as typed but constrained on the way in.
 *
 * Slashes are refused rather than escaped: a name containing one would produce
 * a path with a segment boundary the folder does not actually have, and every
 * `LIKE` in this file would then be wrong about the tree.
 */
function validateName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { ok: false, message: "Give the folder a name." };
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return {
      ok: false,
      message: `Folder names are limited to ${MAX_FOLDER_NAME_LENGTH} characters.`,
    };
  }
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, message: "Folder names cannot contain slashes." };
  }
  // Control characters, including the NUL that truncates C-style strings
  // and would let a name display as one thing and be handled as another.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    return { ok: false, message: "That folder name contains characters we can't store." };
  }
  return { ok: true, name };
}

async function findFolder(db: Database, ctx: TenantContext, publicId: string) {
  const rows = await db
    .select({
      id: mediaFolders.id,
      publicId: mediaFolders.publicId,
      name: mediaFolders.name,
      path: mediaFolders.path,
      depth: mediaFolders.depth,
      parentId: mediaFolders.parentId,
    })
    .from(mediaFolders)
    .where(
      and(
        eq(mediaFolders.publicId, publicId),
        eq(mediaFolders.organizationId, ctx.organizationId),
        isNull(mediaFolders.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve a folder this tenant owns, or throw. Exported for the asset side. */
export async function requireOwnFolder(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<{ id: string; path: string; depth: number }> {
  const folder = await findFolder(db, ctx, publicId);
  if (!folder) throw new NotFoundError();
  return { id: folder.id, path: folder.path, depth: folder.depth };
}

/**
 * The whole tree, with a count of ready assets on each folder.
 *
 * One query rather than one per folder: a client with forty folders would
 * otherwise cost forty round trips to draw a sidebar. Only `ready` assets are
 * counted, because a count that includes an image still processing tells
 * someone they have something they cannot yet use.
 */
export async function listFolders(
  db: Database,
  ctx: TenantContext,
): Promise<FolderNode[]> {
  /*
   * Joins rather than correlated subqueries, and that is not a style choice.
   *
   * A raw `sql` template renders an interpolated column as a *bare* identifier
   * — `${mediaFolders.id}` becomes `"id"`, not `"media_folders"."id"`. Inside
   * a subquery over `media_assets`, that bare `"id"` binds to the inner table,
   * so `a."folder_id" = "id"` silently became `a."folder_id" = a."id"`: a
   * condition that is essentially never true, and which Postgres accepts
   * without complaint because both tables happen to have an `id` column.
   *
   * The visible symptom was every folder reporting zero images while the
   * folder itself listed its contents perfectly. Joins make the relationship
   * explicit and cannot mis-resolve this way.
   */
  const parent = alias(mediaFolders, "parent_folder");

  const rows = await db
    .select({
      publicId: mediaFolders.publicId,
      name: mediaFolders.name,
      path: mediaFolders.path,
      depth: mediaFolders.depth,
      parentPublicId: parent.publicId,
      assetCount: sql<string>`COUNT(${mediaAssets.id})`,
    })
    .from(mediaFolders)
    .leftJoin(parent, eq(parent.id, mediaFolders.parentId))
    // The readiness conditions live in the join, not in a WHERE: moving them
    // to WHERE would turn the LEFT JOIN into an inner one and drop every empty
    // folder from the sidebar.
    .leftJoin(
      mediaAssets,
      and(
        eq(mediaAssets.folderId, mediaFolders.id),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .where(
      and(
        eq(mediaFolders.organizationId, ctx.organizationId),
        isNull(mediaFolders.deletedAt),
      ),
    )
    .groupBy(
      mediaFolders.id,
      mediaFolders.publicId,
      mediaFolders.name,
      mediaFolders.path,
      mediaFolders.depth,
      parent.publicId,
    )
    .orderBy(asc(mediaFolders.path));

  return rows.map((row) => ({
    publicId: row.publicId,
    name: row.name,
    path: row.path,
    depth: row.depth,
    parentPublicId: row.parentPublicId ?? null,
    assetCount: Number(row.assetCount ?? 0),
  }));
}

export async function createFolder(
  db: Database,
  ctx: TenantContext,
  input: { name: string; parentPublicId?: string | null },
): Promise<FolderMutation> {
  assertMutable(ctx);

  const checked = validateName(input.name);
  if (!checked.ok) return checked;

  let parentId: string | null = null;
  let parentPath: string | null = null;
  let depth = 0;

  if (input.parentPublicId) {
    const parent = await findFolder(db, ctx, input.parentPublicId);
    if (!parent) return { ok: false, message: "We couldn't find that folder." };
    parentId = parent.id;
    parentPath = parent.path;
    depth = parent.depth + 1;
    if (depth > MAX_FOLDER_DEPTH) {
      return {
        ok: false,
        message: `Folders can be nested up to ${MAX_FOLDER_DEPTH} deep.`,
      };
    }
  }

  const path = childPath(parentPath, checked.name);
  const publicId = newPublicId();

  try {
    await db.insert(mediaFolders).values({
      publicId,
      organizationId: ctx.organizationId,
      parentId,
      name: checked.name,
      path,
      depth,
      createdBy: ctx.userId,
    });
  } catch (error) {
    // The unique index on (organization_id, path) is the authority on sibling
    // names. Catching its violation is how a concurrent create of the same name
    // reports "already exists" rather than a 500.
    if (isUniqueViolation(error)) {
      return { ok: false, message: `There is already a folder called "${checked.name}" here.` };
    }
    throw error;
  }

  return { ok: true, publicId };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

/**
 * Rewrite this folder's path and every descendant's.
 *
 * `overlay` is used rather than string concatenation on a `replace`: replacing
 * the old prefix textually would also rewrite a *later* occurrence of the same
 * substring inside a deeper path. Overlaying the first `length(old)` characters
 * touches only the prefix, which is the only part that moved.
 */
async function rewriteSubtree(
  db: Database,
  ctx: TenantContext,
  oldPath: string,
  newPath: string,
  depthDelta: number,
): Promise<void> {
  if (oldPath === newPath && depthDelta === 0) return;

  await db
    .update(mediaFolders)
    .set({
      path: sql`overlay(${mediaFolders.path} placing ${newPath} from 1 for ${oldPath.length})`,
      depth: sql`${mediaFolders.depth} + ${depthDelta}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mediaFolders.organizationId, ctx.organizationId),
        like(mediaFolders.path, `${oldPath}/%`),
      ),
    );
}

export async function renameFolder(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  rawName: string,
): Promise<FolderMutation> {
  assertMutable(ctx);

  const checked = validateName(rawName);
  if (!checked.ok) return checked;

  const folder = await findFolder(db, ctx, publicId);
  if (!folder) return { ok: false, message: "We couldn't find that folder." };

  const parentPath = folder.path.slice(0, folder.path.lastIndexOf("/")) || null;
  const newPath = childPath(parentPath, checked.name);

  if (newPath === folder.path) {
    // Same path, different capitalisation. Store the new spelling.
    await db
      .update(mediaFolders)
      .set({ name: checked.name, updatedAt: new Date() })
      .where(eq(mediaFolders.id, folder.id));
    return { ok: true, publicId };
  }

  try {
    await db
      .update(mediaFolders)
      .set({ name: checked.name, path: newPath, updatedAt: new Date() })
      .where(eq(mediaFolders.id, folder.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, message: `There is already a folder called "${checked.name}" here.` };
    }
    throw error;
  }

  await rewriteSubtree(db, ctx, folder.path, newPath, 0);
  return { ok: true, publicId };
}

/**
 * Move a folder under a new parent, or to the root.
 *
 * The cycle check is the whole reason this is not a one-line update. A tree
 * that contains a cycle is not merely wrong data: every `LIKE` traversal over
 * it either loops or silently returns a subtree that excludes half of itself,
 * and no query in this file would report an error while doing so.
 */
export async function moveFolder(
  db: Database,
  ctx: TenantContext,
  publicId: string,
  newParentPublicId: string | null,
): Promise<FolderMutation> {
  assertMutable(ctx);

  const folder = await findFolder(db, ctx, publicId);
  if (!folder) return { ok: false, message: "We couldn't find that folder." };

  let parentId: string | null = null;
  let parentPath: string | null = null;
  let parentDepth = -1;

  if (newParentPublicId) {
    const parent = await findFolder(db, ctx, newParentPublicId);
    if (!parent) return { ok: false, message: "We couldn't find the folder you're moving into." };

    if (parent.id === folder.id) {
      return { ok: false, message: "A folder can't be moved inside itself." };
    }
    // The cycle check: is the destination inside the thing being moved?
    if (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`)) {
      return {
        ok: false,
        message: "A folder can't be moved into one of its own subfolders.",
      };
    }

    parentId = parent.id;
    parentPath = parent.path;
    parentDepth = parent.depth;
  }

  const newDepth = parentDepth + 1;
  const depthDelta = newDepth - folder.depth;

  // Depth is checked against the deepest descendant, not the folder itself.
  // Moving a two-level folder near the limit would otherwise pass here and then
  // violate the database's depth constraint partway through the subtree
  // rewrite, leaving the tree half-moved.
  const deepest = await db
    .select({ maxDepth: sql<number>`COALESCE(MAX(${mediaFolders.depth}), 0)` })
    .from(mediaFolders)
    .where(
      and(
        eq(mediaFolders.organizationId, ctx.organizationId),
        isNull(mediaFolders.deletedAt),
        like(mediaFolders.path, `${folder.path}/%`),
      ),
    );

  const subtreeMax = Math.max(folder.depth, Number(deepest[0]?.maxDepth ?? 0));
  if (subtreeMax + depthDelta > MAX_FOLDER_DEPTH) {
    return {
      ok: false,
      message: `That move would nest folders more than ${MAX_FOLDER_DEPTH} deep.`,
    };
  }

  const newPath = childPath(parentPath, folder.name);
  if (newPath === folder.path && parentId === folder.parentId) {
    return { ok: true, publicId };
  }

  try {
    await db
      .update(mediaFolders)
      .set({ parentId, path: newPath, depth: newDepth, updatedAt: new Date() })
      .where(eq(mediaFolders.id, folder.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        message: `There is already a folder called "${folder.name}" in that place.`,
      };
    }
    throw error;
  }

  await rewriteSubtree(db, ctx, folder.path, newPath, depthDelta);
  return { ok: true, publicId };
}

/**
 * Trash a folder and its subfolders. The images inside are kept.
 *
 * Assets move to the library root rather than following the folder into the
 * bin. Someone tidying up must not be one click away from losing the only copy
 * of their work, and "your folder is gone but every photo is still here" is a
 * recoverable surprise where the alternative is not.
 */
export async function deleteFolder(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<{ ok: boolean; message: string; releasedAssets: number }> {
  assertMutable(ctx);

  const folder = await findFolder(db, ctx, publicId);
  if (!folder) {
    return { ok: false, message: "We couldn't find that folder.", releasedAssets: 0 };
  }

  const subtree = await db
    .select({ id: mediaFolders.id })
    .from(mediaFolders)
    .where(
      and(
        eq(mediaFolders.organizationId, ctx.organizationId),
        isNull(mediaFolders.deletedAt),
        sql`(${mediaFolders.path} = ${folder.path} OR ${mediaFolders.path} LIKE ${`${folder.path}/%`})`,
      ),
    );

  const ids = subtree.map((row) => row.id);
  if (ids.length === 0) {
    return { ok: false, message: "We couldn't find that folder.", releasedAssets: 0 };
  }

  const released = await db
    .update(mediaAssets)
    .set({ folderId: null, updatedAt: new Date() })
    .where(
      and(
        eq(mediaAssets.organizationId, ctx.organizationId),
        sql`${mediaAssets.folderId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      ),
    )
    .returning({ id: mediaAssets.id });

  await db
    .update(mediaFolders)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(mediaFolders.organizationId, ctx.organizationId),
        sql`${mediaFolders.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      ),
    );

  const count = released.length;
  return {
    ok: true,
    releasedAssets: count,
    message:
      count === 0
        ? "Folder deleted."
        : count === 1
          ? "Folder deleted. The image inside it is now in All images."
          : `Folder deleted. The ${count} images inside it are now in All images.`,
  };
}
