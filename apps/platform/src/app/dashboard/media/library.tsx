"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AssetSummary } from "@/db/repositories/client/media-assets";
import type { FolderNode } from "@/db/repositories/client/media-folders";
import type { StorageUsage } from "@/db/repositories/client/media-assets";
import { FULL_WIDTH_MIN_EDGE } from "@/lib/media/constants";
import { Uploader } from "./uploader";
import {
  createFolderAction,
  deleteFolderAction,
  moveAssetsAction,
  moveFolderAction,
  renameFolderAction,
  restoreAssetsAction,
  retryAssetAction,
  trashAssetsAction,
  updateAssetAction,
} from "./actions";

/**
 * The media library.
 *
 * A client component because selection, search and the upload queue are all
 * local interaction state; the data itself is fetched on the server and passed
 * in. Mutations go back through server actions, and the router is refreshed
 * rather than the state being patched locally — one source of truth beats two
 * that can disagree about whether an image is ready.
 *
 * Nothing here publishes anything. Filing an image in a folder changes where it
 * is filed and nothing else, which is said in the interface as well as being
 * true in the code, because a client who suspects that moving a photo might
 * rearrange their website will not use folders at all.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export interface LibraryProps {
  folders: FolderNode[];
  assets: AssetSummary[];
  usage: StorageUsage;
  currentFolder: string | null;
  search: string;
  trashed: boolean;
}

export function MediaLibrary({
  folders,
  assets,
  usage,
  currentFolder,
  search,
  trashed,
}: LibraryProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState(search);

  const folderLabel = useMemo(() => {
    if (currentFolder === null) return "All images";
    return folders.find((f) => f.publicId === currentFolder)?.name ?? "All images";
  }, [currentFolder, folders]);

  const detailAsset = detail ? assets.find((a) => a.publicId === detail) : null;

  function navigate(next: {
    folder?: string | null;
    q?: string;
    trash?: boolean;
  }) {
    const params = new URLSearchParams();
    const folder = next.folder === undefined ? currentFolder : next.folder;
    const q = next.q === undefined ? search : next.q;
    const trash = next.trash === undefined ? trashed : next.trash;

    if (folder) params.set("folder", folder);
    if (q) params.set("q", q);
    if (trash) params.set("trash", "1");

    setSelected(new Set());
    router.push(`/dashboard/media${params.size ? `?${params}` : ""}`);
  }

  function toggle(publicId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(publicId)) next.delete(publicId);
      else next.add(publicId);
      return next;
    });
  }

  /** Run a server action with the current selection, then refresh. */
  function withSelection(
    action: (previous: null, formData: FormData) => Promise<{ ok: boolean; message: string }>,
    extra: Record<string, string> = {},
  ) {
    const formData = new FormData();
    for (const id of selected) formData.append("assetPublicIds", id);
    for (const [key, value] of Object.entries(extra)) formData.set(key, value);

    startTransition(async () => {
      const result = await action(null, formData);
      setNotice(result);
      if (result.ok) setSelected(new Set());
      router.refresh();
    });
  }

  function runFolderAction(
    action: (previous: null, formData: FormData) => Promise<{ ok: boolean; message: string }>,
    fields: Record<string, string>,
  ) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    startTransition(async () => {
      const result = await action(null, formData);
      setNotice(result);
      router.refresh();
    });
  }

  const overQuota = usage.percentUsed >= 90;

  return (
    <div className="media-layout">
      {/* ---------------------------------------------------------------- */}
      {/* Folders                                                           */}
      {/* ---------------------------------------------------------------- */}
      <aside className="media-sidebar">
        <div className="card">
          <div className="card-head">
            <h2>Folders</h2>
          </div>

          <nav aria-label="Folders">
            <button
              type="button"
              className={`media-folder${currentFolder === null && !trashed ? " is-current" : ""}`}
              onClick={() => navigate({ folder: null, trash: false })}
            >
              All images
            </button>

            {folders.map((folder) => (
              <button
                key={folder.publicId}
                type="button"
                className={`media-folder${folder.publicId === currentFolder ? " is-current" : ""}`}
                style={{ paddingLeft: `${0.6 + folder.depth * 0.9}rem` }}
                onClick={() => navigate({ folder: folder.publicId, trash: false })}
              >
                {folder.name}
                <span className="muted"> {folder.assetCount}</span>
              </button>
            ))}

            <button
              type="button"
              className={`media-folder${trashed ? " is-current" : ""}`}
              onClick={() => navigate({ folder: null, trash: true })}
            >
              Trash
            </button>
          </nav>

          <form
            className="media-folder-new"
            action={(formData) => {
              runFolderAction(createFolderAction, {
                name: String(formData.get("name") ?? ""),
                parentPublicId: currentFolder ?? "",
              });
            }}
          >
            <label htmlFor="new-folder" className="visually-hidden">
              New folder name
            </label>
            <input
              id="new-folder"
              name="name"
              type="text"
              placeholder={
                currentFolder ? `New folder in ${folderLabel}` : "New folder"
              }
              maxLength={80}
              required
            />
            <button type="submit" className="secondary" disabled={pending}>
              Add
            </button>
          </form>

          {currentFolder && (
            <div className="media-folder-tools">
              <form
                action={(formData) => {
                  runFolderAction(renameFolderAction, {
                    folderPublicId: currentFolder,
                    name: String(formData.get("name") ?? ""),
                  });
                }}
              >
                <label htmlFor="rename-folder" className="visually-hidden">
                  Rename this folder
                </label>
                <input
                  id="rename-folder"
                  name="name"
                  type="text"
                  defaultValue={folderLabel}
                  maxLength={80}
                />
                <button type="submit" className="secondary" disabled={pending}>
                  Rename
                </button>
              </form>

              <form
                action={(formData) => {
                  runFolderAction(moveFolderAction, {
                    folderPublicId: currentFolder,
                    destinationPublicId: String(formData.get("destinationPublicId") ?? ""),
                  });
                }}
              >
                <label htmlFor="move-folder" className="visually-hidden">
                  Move this folder into
                </label>
                <select id="move-folder" name="destinationPublicId" defaultValue="">
                  <option value="">Top level</option>
                  {folders
                    // A folder cannot go inside itself or its own descendants.
                    // The server refuses either way; hiding them here means the
                    // client is not offered a choice that will be rejected.
                    .filter((f) => {
                      const self = folders.find((x) => x.publicId === currentFolder);
                      if (!self) return true;
                      return (
                        f.publicId !== currentFolder &&
                        !f.path.startsWith(`${self.path}/`)
                      );
                    })
                    .map((f) => (
                      <option key={f.publicId} value={f.publicId}>
                        {f.path}
                      </option>
                    ))}
                </select>
                <button type="submit" className="secondary" disabled={pending}>
                  Move
                </button>
              </form>

              <button
                type="button"
                className="secondary"
                disabled={pending}
                onClick={() => {
                  runFolderAction(deleteFolderAction, {
                    folderPublicId: currentFolder,
                  });
                  navigate({ folder: null });
                }}
              >
                Delete folder
              </button>
              <p className="field-hint">
                Deleting a folder keeps every image in it — they move to All
                images.
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Storage</h2>
          </div>
          <div
            className="media-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usage.percentUsed)}
            aria-label="Storage used"
          >
            <div
              className="media-bar-fill"
              style={{ width: `${Math.min(100, usage.percentUsed)}%` }}
            />
          </div>
          <p className="field-hint">
            {formatBytes(usage.totalBytes)} of {formatBytes(usage.quotaBytes)} used
            &mdash; {usage.assetCount}{" "}
            {usage.assetCount === 1 ? "image" : "images"}.
          </p>
          {/* Named separately because a client asking why 200 MB of photos
              reads as 260 MB deserves the real answer. */}
          <p className="field-hint">
            Your originals are {formatBytes(usage.originalBytes)}; the website
            sizes we generate add {formatBytes(usage.derivativeBytes)}.
            {usage.trashedBytes > 0 && (
              <> Trash is holding {formatBytes(usage.trashedBytes)}.</>
            )}
          </p>
          {overQuota && (
            <p className="notice" style={{ marginBottom: 0 }}>
              You are close to your storage limit. Emptying the trash frees
              space, or get in touch and we will raise it.
            </p>
          )}
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Images                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div className="media-main">
        {notice && (
          <p className={notice.ok ? "notice notice-success" : "error"}>
            {notice.message}
          </p>
        )}

        {!trashed && (
          <Uploader
            folderPublicId={currentFolder}
            folderLabel={folderLabel}
            onUploaded={() => router.refresh()}
          />
        )}

        <div className="card">
          <div className="card-head">
            <h2>{trashed ? "Trash" : folderLabel}</h2>
          </div>

          <form
            className="media-search"
            action={() => navigate({ q: searchTerm })}
          >
            <label htmlFor="media-search" className="visually-hidden">
              Search your images
            </label>
            <input
              id="media-search"
              type="search"
              value={searchTerm}
              placeholder="Search by name, description or filename"
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            <button type="submit" className="secondary" disabled={pending}>
              Search
            </button>
            {search && (
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setSearchTerm("");
                  navigate({ q: "" });
                }}
              >
                Clear
              </button>
            )}
          </form>

          {selected.size > 0 && (
            <div className="media-bulk">
              <span>
                <strong>{selected.size}</strong>{" "}
                {selected.size === 1 ? "image" : "images"} selected
              </span>

              {trashed ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={pending}
                  onClick={() => withSelection(restoreAssetsAction)}
                >
                  Restore
                </button>
              ) : (
                <>
                  <label htmlFor="bulk-move" className="visually-hidden">
                    Move selected images to
                  </label>
                  <select
                    id="bulk-move"
                    defaultValue=""
                    disabled={pending}
                    onChange={(event) => {
                      if (event.target.value === "") return;
                      withSelection(moveAssetsAction, {
                        folderPublicId:
                          event.target.value === "__root__" ? "" : event.target.value,
                      });
                      event.target.value = "";
                    }}
                  >
                    <option value="">Move to…</option>
                    <option value="__root__">All images (no folder)</option>
                    {folders.map((f) => (
                      <option key={f.publicId} value={f.publicId}>
                        {f.path}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className="secondary"
                    disabled={pending}
                    onClick={() => withSelection(trashAssetsAction)}
                  >
                    Move to trash
                  </button>
                </>
              )}

              <button
                type="button"
                className="linklike"
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </button>
            </div>
          )}

          {assets.length === 0 ? (
            <p className="empty">
              {search
                ? `Nothing matches “${search}”.`
                : trashed
                  ? "Nothing in the trash."
                  : "No images here yet. Add some above."}
            </p>
          ) : (
            <ul className="media-grid">
              {assets.map((asset) => {
                const isSelected = selected.has(asset.publicId);
                const lowRes =
                  asset.width !== null &&
                  asset.height !== null &&
                  Math.max(asset.width, asset.height) < FULL_WIDTH_MIN_EDGE;

                return (
                  <li key={asset.publicId}>
                    <div className={`media-tile${isSelected ? " is-selected" : ""}`}>
                      <label className="media-tile-pick">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(asset.publicId)}
                        />
                        <span className="visually-hidden">
                          Select {asset.title ?? asset.originalFilename}
                        </span>
                      </label>

                      <button
                        type="button"
                        className="media-tile-body"
                        onClick={() => setDetail(asset.publicId)}
                      >
                        <span className="media-tile-media">
                          {asset.hasThumbnail ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/media/assets/${asset.publicId}/thumb`}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span className="media-tile-placeholder">
                              {asset.status === "failed" ? "Failed" : "Preparing…"}
                            </span>
                          )}
                        </span>

                        <span className="media-tile-name">
                          {asset.title ?? asset.originalFilename}
                        </span>
                        <span className="media-tile-meta">
                          {asset.width && asset.height
                            ? `${asset.width}×${asset.height}`
                            : "—"}{" "}
                          · {formatBytes(asset.byteSize)}
                        </span>
                        {/* Flagged, never fixed by upscaling. The number is put
                            in front of the client and the choice stays theirs. */}
                        {lowRes && (
                          <span className="pill pill-warning">Small</span>
                        )}
                        {asset.status === "failed" && (
                          <span className="pill pill-danger">Needs attention</span>
                        )}
                        {asset.status === "processing" && (
                          <span className="pill pill-info">Preparing</span>
                        )}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* -------------------------------------------------------------- */}
        {/* Detail                                                          */}
        {/* -------------------------------------------------------------- */}
        {detailAsset && (
          <div className="card">
            <div className="card-head">
              <h2>{detailAsset.title ?? detailAsset.originalFilename}</h2>
              <button
                type="button"
                className="linklike"
                onClick={() => setDetail(null)}
              >
                Close
              </button>
            </div>

            <div className="media-detail">
              <div className="media-detail-preview">
                {detailAsset.hasThumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/assets/${detailAsset.publicId}/preview`}
                    alt={detailAsset.title ?? detailAsset.originalFilename}
                  />
                ) : (
                  <p className="empty">No preview yet.</p>
                )}
              </div>

              <div className="media-detail-facts">
                <dl className="detail-grid">
                  <dt>File</dt>
                  <dd>{detailAsset.originalFilename}</dd>
                  <dt>Size</dt>
                  <dd>
                    {detailAsset.width && detailAsset.height
                      ? `${detailAsset.width} × ${detailAsset.height} pixels`
                      : "Unknown"}{" "}
                    · {formatBytes(detailAsset.byteSize)}
                  </dd>
                  <dt>Format</dt>
                  <dd>
                    {detailAsset.contentType ?? "Unknown"}
                    {detailAsset.hasAlpha ? " · has transparency" : ""}
                  </dd>
                  <dt>Folder</dt>
                  <dd>{detailAsset.folderPath ?? "All images"}</dd>
                </dl>

                {detailAsset.status === "failed" && (
                  <div className="error">
                    <p style={{ marginTop: 0 }}>{detailAsset.failureReason}</p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={pending}
                      onClick={() =>
                        runFolderAction(retryAssetAction, {
                          assetPublicId: detailAsset.publicId,
                        })
                      }
                    >
                      Try again
                    </button>
                  </div>
                )}

                <form
                  className="form"
                  action={(formData) => {
                    runFolderAction(updateAssetAction, {
                      assetPublicId: detailAsset.publicId,
                      title: String(formData.get("title") ?? ""),
                      description: String(formData.get("description") ?? ""),
                    });
                  }}
                >
                  <label htmlFor="asset-title">Name</label>
                  <input
                    id="asset-title"
                    name="title"
                    type="text"
                    defaultValue={detailAsset.title ?? ""}
                    placeholder="e.g. Winter hero"
                    maxLength={120}
                  />
                  <p className="field-hint">
                    Naming an image is what lets you refer to it when you ask for
                    a change &mdash; &ldquo;use the winter hero at the top&rdquo;.
                  </p>

                  <label htmlFor="asset-description">Description</label>
                  <textarea
                    id="asset-description"
                    name="description"
                    rows={3}
                    defaultValue={detailAsset.description ?? ""}
                    placeholder="Anything that should appear beside it — a price, a material, a size."
                    maxLength={600}
                  />

                  <button type="submit" disabled={pending}>
                    Save
                  </button>
                </form>

                <a
                  className="linklike"
                  href={`/api/media/assets/${detailAsset.publicId}/original`}
                >
                  Download the original
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
