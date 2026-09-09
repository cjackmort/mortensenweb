"use client";

import { useState, useTransition } from "react";
import { FULL_WIDTH_MIN_EDGE } from "@/lib/media/constants";
import { previewFolderSelection } from "../media/actions";

/**
 * Choosing library images for a change request.
 *
 * These are identifiers, not bytes. Whatever the client picks, the submission
 * stays a few hundred bytes of text — which is the property that removes the
 * failure this whole change exists to remove.
 *
 * ## Selecting a whole folder shows its contents first
 *
 * "Attach this folder" is genuinely useful and genuinely dangerous: a folder is
 * a moving target, and one that silently resolves to twelve images when someone
 * meant three produces a request nobody actually made. So the selection is
 * *resolved and displayed* before it is applied, including a count of anything
 * skipped for not being ready. The client confirms what they can see.
 */

export interface PickableAsset {
  publicId: string;
  title: string;
  filename: string;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  folderPublicId: string | null;
}

export interface PickableFolder {
  publicId: string;
  path: string;
  name: string;
}

interface PendingFolder {
  folderPath: string;
  assets: { publicId: string; title: string; width: number | null; height: number | null }[];
  skippedNotReady: number;
}

export function AssetPicker({
  assets,
  folders,
  selected,
  onChange,
}: {
  assets: PickableAsset[];
  folders: PickableFolder[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(selected.length > 0);
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [resolving, startResolving] = useTransition();

  const chosen = new Set(selected);

  function toggle(publicId: string) {
    const next = new Set(chosen);
    if (next.has(publicId)) next.delete(publicId);
    else next.add(publicId);
    onChange([...next]);
  }

  function requestFolder(folderPublicId: string) {
    setFolderError(null);
    setPendingFolder(null);
    if (!folderPublicId) return;

    startResolving(async () => {
      const result = await previewFolderSelection(folderPublicId);
      if (!result.ok) {
        setFolderError(result.message);
        return;
      }
      if (result.assets.length === 0) {
        setFolderError(
          result.skippedNotReady > 0
            ? "Everything in that folder is still being prepared. Give it a moment."
            : "That folder has no images in it yet.",
        );
        return;
      }
      setPendingFolder(result);
    });
  }

  function confirmFolder() {
    if (!pendingFolder) return;
    const next = new Set(chosen);
    for (const asset of pendingFolder.assets) next.add(asset.publicId);
    onChange([...next]);
    setPendingFolder(null);
  }

  if (assets.length === 0) {
    return (
      <p className="field-hint">
        No images in your library yet.{" "}
        <a href="/dashboard/media">Add some</a> and they will appear here to
        choose from.
      </p>
    );
  }

  return (
    <div className="media-picker">
      <div className="media-picker-head">
        <strong>
          {selected.length === 0
            ? "Add images from your library"
            : `${selected.length} ${selected.length === 1 ? "image" : "images"} chosen`}
        </strong>
        <button
          type="button"
          className="linklike"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide" : "Choose images"}
        </button>
      </div>

      {/* The identifiers the form actually submits. Hidden inputs rather than
          component state alone, so the selection survives a non-JavaScript
          submit and is visible in the request payload. */}
      {selected.map((publicId) => (
        <input key={publicId} type="hidden" name="assetPublicIds" value={publicId} />
      ))}

      {open && (
        <>
          {folders.length > 0 && (
            <div style={{ marginBottom: "0.6rem" }}>
              <label htmlFor="folder-select" className="visually-hidden">
                Add every ready image from a folder
              </label>
              <select
                id="folder-select"
                defaultValue=""
                disabled={resolving}
                onChange={(event) => {
                  requestFolder(event.target.value);
                  event.target.value = "";
                }}
              >
                <option value="">Add a whole folder…</option>
                {folders.map((folder) => (
                  <option key={folder.publicId} value={folder.publicId}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </div>
          )}

          {folderError && <p className="error">{folderError}</p>}

          {/* Confirmation, not a silent bulk add. The client sees exactly what
              the folder resolved to before any of it is applied. */}
          {pendingFolder && (
            <div className="media-picker-confirm">
              <p style={{ marginTop: 0 }}>
                <strong>
                  Add {pendingFolder.assets.length}{" "}
                  {pendingFolder.assets.length === 1 ? "image" : "images"} from{" "}
                  {pendingFolder.folderPath}?
                </strong>
              </p>
              <ul style={{ margin: "0 0 0.5rem", paddingLeft: "1.1rem" }}>
                {pendingFolder.assets.slice(0, 8).map((asset) => (
                  <li key={asset.publicId}>{asset.title}</li>
                ))}
                {pendingFolder.assets.length > 8 && (
                  <li className="muted">
                    and {pendingFolder.assets.length - 8} more
                  </li>
                )}
              </ul>
              {pendingFolder.skippedNotReady > 0 && (
                <p className="field-hint">
                  {pendingFolder.skippedNotReady}{" "}
                  {pendingFolder.skippedNotReady === 1 ? "image is" : "images are"}{" "}
                  still being prepared and will not be included.
                </p>
              )}
              <button
                type="button"
                style={{ width: "auto" }}
                onClick={confirmFolder}
              >
                Add these
              </button>{" "}
              <button
                type="button"
                className="linklike"
                onClick={() => setPendingFolder(null)}
              >
                Cancel
              </button>
            </div>
          )}

          <ul className="media-picker-grid">
            {assets.map((asset) => {
              const isChosen = chosen.has(asset.publicId);
              return (
                <li key={asset.publicId}>
                  <label
                    className={`media-picker-tile${isChosen ? " is-selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChosen}
                      onChange={() => toggle(asset.publicId)}
                    />
                    {asset.hasThumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/media/assets/${asset.publicId}/thumb`}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span
                        style={{
                          display: "grid",
                          placeItems: "center",
                          aspectRatio: "1 / 1",
                        }}
                      >
                        —
                      </span>
                    )}
                    <span title={asset.title}>{asset.title}</span>
                  </label>
                </li>
              );
            })}
          </ul>

          {/* A warning, never a refusal and never an upscale. The client is
              given the number and decides. */}
          {selected.some((id) => {
            const asset = assets.find((a) => a.publicId === id);
            return (
              asset?.width != null &&
              asset?.height != null &&
              Math.max(asset.width, asset.height) < FULL_WIDTH_MIN_EDGE
            );
          }) && (
            <p className="notice" style={{ marginTop: "0.6rem" }}>
              Some of these are small (under {FULL_WIDTH_MIN_EDGE}px). They will
              look soft used full width across a page — fine beside text, or at a
              smaller size. We will not stretch them.
            </p>
          )}
        </>
      )}
    </div>
  );
}
