"use client";

import { useCallback, useRef, useState } from "react";
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_ORIGINAL_BYTES,
  SUPPORTED_FORMATS_LABEL,
  UPLOAD_ACCEPT_ATTRIBUTE,
} from "@/lib/media/constants";
import {
  cancelUpload,
  uploadFile,
  type UploadHandle,
} from "@/lib/media/upload-client";

/**
 * Choosing files and watching them arrive.
 *
 * Two things this does that the old photo field did not, and both are the
 * point:
 *
 *  - **Originals are sent.** No canvas, no re-encode, no 1600px cap, no
 *    PNG-to-JPEG conversion that quietly destroys transparency. The bytes that
 *    reach storage are the bytes the client chose.
 *  - **A failure is per file.** One photo failing leaves the others uploaded
 *    and offers a retry on just that one, rather than taking down the whole
 *    interaction.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function phaseLabel(handle: UploadHandle): string {
  switch (handle.phase) {
    case "hashing":
      return "Checking the file…";
    case "uploading":
      return `Uploading — ${Math.round(handle.progress.fraction * 100)}%`;
    case "finishing":
      return "Finishing…";
    case "processing":
      // Deliberately distinct from "done". The image exists but has no
      // thumbnail yet, and cannot be attached to a request until it does.
      return "Uploaded — preparing sizes";
    case "done":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

let counter = 0;

export function Uploader({
  folderPublicId,
  folderLabel,
  onUploaded,
}: {
  folderPublicId: string | null;
  folderLabel: string;
  /** Fired once anything finishes, so the page can refresh its grid. */
  onUploaded: () => void;
}) {
  const [handles, setHandles] = useState<UploadHandle[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = useCallback((next: UploadHandle) => {
    setHandles((current) =>
      current.map((h) => (h.localId === next.localId ? { ...next } : h)),
    );
  }, []);

  const run = useCallback(
    async (queue: UploadHandle[]) => {
      // A small concurrency window rather than all at once. Six parallel
      // uploads on a phone connection make every one of them slow and the
      // progress meaningless; they also multiply the chance that one drops.
      const pending = [...queue];
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT_UPLOADS, pending.length) },
        async () => {
          for (;;) {
            const next = pending.shift();
            if (!next) return;
            await uploadFile(next, { folderPublicId, onChange: update });
          }
        },
      );
      await Promise.all(workers);
      onUploaded();
    },
    [folderPublicId, onUploaded, update],
  );

  const accept = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;

      const created = files.map((file) => {
        counter += 1;
        const handle: UploadHandle = {
          localId: `u${counter}`,
          file,
          phase: "hashing",
          retryable: true,
          progress: { fraction: 0, partsSent: 0, partsTotal: 1 },
        };
        // Refused before a byte moves, with the actual size named. Finding out
        // after a long upload that a file was always too large is the version
        // of this that wastes someone's time.
        if (file.size > MAX_ORIGINAL_BYTES) {
          handle.phase = "failed";
          handle.retryable = false;
          handle.error = `This file is ${formatBytes(file.size)}. The limit is ${Math.floor(
            MAX_ORIGINAL_BYTES / 1024 / 1024,
          )} MB per image.`;
        }
        return handle;
      });

      setHandles((current) => [...current, ...created]);
      void run(created.filter((h) => h.phase !== "failed"));
    },
    [run],
  );

  const retry = useCallback(
    (localId: string) => {
      setHandles((current) => {
        const target = current.find((h) => h.localId === localId);
        if (target) {
          void uploadFile(
            { ...target, phase: "hashing", error: undefined },
            { folderPublicId, onChange: update },
          ).then(onUploaded);
        }
        return current.map((h) =>
          h.localId === localId ? { ...h, phase: "hashing", error: undefined } : h,
        );
      });
    },
    [folderPublicId, onUploaded, update],
  );

  const remove = useCallback((localId: string) => {
    setHandles((current) => {
      const target = current.find((h) => h.localId === localId);
      if (target?.uploadPublicId && target.phase === "failed") {
        void cancelUpload(target.uploadPublicId);
      }
      return current.filter((h) => h.localId !== localId);
    });
  }, []);

  const active = handles.filter(
    (h) => h.phase !== "done" && h.phase !== "processing",
  ).length;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Add images</h2>
      </div>

      <div
        className={`media-drop${dragging ? " is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(Array.from(event.dataTransfer.files));
        }}
      >
        <p style={{ margin: 0 }}>
          <button
            type="button"
            className="linklike"
            onClick={() => inputRef.current?.click()}
          >
            Choose images
          </button>{" "}
          or drop them here.
        </p>
        <p className="field-hint" style={{ marginBottom: 0 }}>
          Going into <strong>{folderLabel}</strong>. {SUPPORTED_FORMATS_LABEL}, up
          to {Math.floor(MAX_ORIGINAL_BYTES / 1024 / 1024)} MB each. Your original
          file is kept exactly as it is — we make the smaller website versions
          separately.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={UPLOAD_ACCEPT_ATTRIBUTE}
          multiple
          className="visually-hidden"
          onChange={(event) => {
            accept(Array.from(event.target.files ?? []));
            // Cleared so choosing the same file twice still fires a change.
            event.target.value = "";
          }}
        />
      </div>

      {handles.length > 0 && (
        <ul className="media-queue">
          {handles.map((handle) => (
            <li key={handle.localId} className="media-queue-item">
              <div className="media-queue-head">
                <span className="media-queue-name" title={handle.file.name}>
                  {handle.file.name}
                </span>
                <span className="muted">{formatBytes(handle.file.size)}</span>
              </div>

              {handle.phase !== "failed" && (
                <div
                  className="media-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(handle.progress.fraction * 100)}
                  aria-label={`Upload progress for ${handle.file.name}`}
                >
                  <div
                    className="media-bar-fill"
                    style={{ width: `${Math.round(handle.progress.fraction * 100)}%` }}
                  />
                </div>
              )}

              <div className="media-queue-foot">
                <span className={handle.phase === "failed" ? "error" : "muted"}>
                  {handle.phase === "failed" ? handle.error : phaseLabel(handle)}
                </span>

                {handle.phase === "failed" && (
                  <span className="media-queue-actions">
                    {/* Retry only where retrying can work. Offering it on a
                        HEIC would invite someone to press it repeatedly. */}
                    {handle.retryable && (
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => retry(handle.localId)}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => remove(handle.localId)}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {active === 0 && handles.length > 0 && (
        <p className="field-hint">
          Images appear below once their website sizes are ready — usually a few
          seconds.
        </p>
      )}
    </div>
  );
}
