"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { mediaAssets } from "@/db/schema";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  createFolder,
  deleteFolder,
  moveFolder,
  renameFolder,
} from "@/db/repositories/client/media-folders";
import {
  moveAssets,
  restoreAssets,
  selectFolderContents,
  trashAssets,
  updateAssetDetails,
} from "@/db/repositories/client/media-assets";
import { retryAsset } from "@/db/repositories/admin/media-jobs";

/**
 * Media library mutations.
 *
 * Everything here is small and textual — a folder name, a title, a list of
 * identifiers. **No image bytes pass through a server action**, which is the
 * property that keeps this whole surface clear of the body limit that broke the
 * old request form. Bytes go to `/api/media/uploads`, in parts.
 *
 * Filing is filing. Nothing in this file publishes anything, queues a change
 * request, or alters a live site — a client can reorganise their library
 * freely, and a request already dispatched keeps the snapshot it was given.
 */

export type MediaActionResult = { ok: boolean; message: string };

const SIGN_IN_AGAIN: MediaActionResult = {
  ok: false,
  message: "Please sign in again.",
};

async function context() {
  const user = await currentUser();
  if (!user?.organizationId) return null;
  return {
    ctx: tenantContextFrom(user, user.organizationId),
    db: await getDb(),
  };
}

function refresh() {
  revalidatePath("/dashboard/media");
  revalidatePath("/dashboard/requests");
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolderAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const parent = String(formData.get("parentPublicId") ?? "").trim();
  const result = await createFolder(session.db, session.ctx, {
    name: String(formData.get("name") ?? ""),
    parentPublicId: parent || null,
  });

  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Folder created." };
}

export async function renameFolderAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const result = await renameFolder(
    session.db,
    session.ctx,
    String(formData.get("folderPublicId") ?? ""),
    String(formData.get("name") ?? ""),
  );

  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Folder renamed." };
}

export async function moveFolderAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const destination = String(formData.get("destinationPublicId") ?? "").trim();
  const result = await moveFolder(
    session.db,
    session.ctx,
    String(formData.get("folderPublicId") ?? ""),
    destination || null,
  );

  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: "Folder moved." };
}

export async function deleteFolderAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const result = await deleteFolder(
    session.db,
    session.ctx,
    String(formData.get("folderPublicId") ?? ""),
  );

  refresh();
  return { ok: result.ok, message: result.message };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function updateAssetAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const result = await updateAssetDetails(
    session.db,
    session.ctx,
    String(formData.get("assetPublicId") ?? ""),
    {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
    },
  );

  if (result.ok) refresh();
  return result;
}

/** Read a repeated form field into a list of identifiers. */
function selectedIds(formData: FormData): string[] {
  return formData
    .getAll("assetPublicIds")
    .map((value) => String(value).trim())
    .filter(Boolean);
}

export async function moveAssetsAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const destination = String(formData.get("folderPublicId") ?? "").trim();
  const result = await moveAssets(
    session.db,
    session.ctx,
    selectedIds(formData),
    destination || null,
  );

  if (result.ok) refresh();
  return result;
}

export async function trashAssetsAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const result = await trashAssets(session.db, session.ctx, selectedIds(formData));
  refresh();
  return { ok: result.ok, message: result.message };
}

export async function restoreAssetsAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const result = await restoreAssets(session.db, session.ctx, selectedIds(formData));
  if (result.ok) refresh();
  return result;
}

/**
 * Try preparing an image again.
 *
 * Scoped through the tenant's own asset lookup first: `retryAsset` takes an
 * internal id and has no context of its own, so the ownership check has to
 * happen here or this becomes a way to queue work against another tenant's row.
 */
export async function retryAssetAction(
  _previous: MediaActionResult | null,
  formData: FormData,
): Promise<MediaActionResult> {
  const session = await context();
  if (!session) return SIGN_IN_AGAIN;

  const publicId = String(formData.get("assetPublicId") ?? "").trim();

  // Both conditions in one query. Looking the asset up by public id and then
  // checking its organization separately is the same thing written in a way
  // that a later refactor can drop half of.
  const rows = await session.db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.publicId, publicId),
        eq(mediaAssets.organizationId, session.ctx.organizationId),
      ),
    )
    .limit(1);

  const target = rows[0];
  if (!target) return { ok: false, message: "We couldn't find that image." };

  await retryAsset(session.db, target.id);
  refresh();
  return { ok: true, message: "Trying that image again — give it a moment." };
}

/**
 * Resolve a folder to the images it currently holds.
 *
 * Returns the list rather than acting on it, because the client has to *see*
 * what "attach this folder" resolved to before they commit. A folder selection
 * that silently expands to twelve images when they meant three is how a request
 * arrives carrying things nobody chose.
 */
export async function previewFolderSelection(
  folderPublicId: string,
): Promise<
  | {
      ok: true;
      folderPath: string;
      assets: { publicId: string; title: string; width: number | null; height: number | null }[];
      skippedNotReady: number;
    }
  | { ok: false; message: string }
> {
  const session = await context();
  if (!session) return { ok: false, message: "Please sign in again." };

  try {
    const selection = await selectFolderContents(
      session.db,
      session.ctx,
      folderPublicId,
    );
    return {
      ok: true,
      folderPath: selection.folderPath,
      skippedNotReady: selection.skippedNotReady,
      assets: selection.assets.map((asset) => ({
        publicId: asset.publicId,
        title: asset.title ?? asset.originalFilename,
        width: asset.width,
        height: asset.height,
      })),
    };
  } catch {
    return { ok: false, message: "We couldn't find that folder." };
  }
}
