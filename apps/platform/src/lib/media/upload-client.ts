/**
 * Uploading a file from the browser, in parts.
 *
 * The whole design exists because Netlify caps a function request body at about
 * 4.5 MB once binary content is base64-encoded, and Netlify Blobs has no
 * presigned upload URL — so an original-resolution photo cannot reach storage
 * in one request by any route. It goes in slices.
 *
 * What that buys, and why each piece is here:
 *
 *  - **Nothing is re-sent that already arrived.** Each part is a separate `PUT`
 *    to an idempotent endpoint. A dropped connection costs one slice.
 *  - **Progress is real.** It is parts confirmed by the server, not bytes
 *    handed to the network stack, so the bar cannot sit at 100% while an
 *    upload is in fact stalled.
 *  - **The checksum is computed before anything is sent.** The server verifies
 *    the assembled file against it, so a truncated or altered upload is caught
 *    rather than stored.
 *
 * Deliberately no dependencies. This is the one piece of the feature that runs
 * on a client's phone on a bad connection, and every kilobyte of it is in the
 * critical path of the thing that was already failing.
 */

export interface UploadProgress {
  /** 0-1, by parts the server has confirmed. */
  fraction: number;
  partsSent: number;
  partsTotal: number;
}

export type UploadPhase =
  | "hashing"
  | "uploading"
  | "finishing"
  | "processing"
  | "done"
  | "failed";

export interface UploadHandle {
  /** Stable across retries, so the UI can keep one row per chosen file. */
  localId: string;
  file: File;
  phase: UploadPhase;
  progress: UploadProgress;
  assetPublicId?: string;
  uploadPublicId?: string;
  error?: string;
  /** False for a refusal that retrying cannot fix — a HEIC, or a corrupt file. */
  retryable: boolean;
}

interface BeginResponse {
  ok: true;
  uploadPublicId: string;
  assetPublicId: string;
  partSize: number;
  partCount: number;
}

/**
 * SHA-256 of the whole file, computed in the browser.
 *
 * Reads the file into memory once. Bounded by the 50 MB per-image limit the
 * server enforces at `beginUpload`, which is well within what a phone can hold
 * — and the alternative, streaming digest, needs a hashing implementation
 * shipped to the client because `crypto.subtle` has no incremental API.
 */
async function fileChecksum(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export interface UploadCallbacks {
  onChange: (handle: UploadHandle) => void;
  signal?: AbortSignal;
}

/**
 * Upload one file, start to finish.
 *
 * Resumable in the practical sense that matters here: on a retry the server is
 * asked which parts it already holds, and only the gaps are sent. A client
 * whose connection dropped at 90% of a 40 MB photo re-sends 4 MB, not 40.
 */
export async function uploadFile(
  handle: UploadHandle,
  options: { folderPublicId?: string | null } & UploadCallbacks,
): Promise<UploadHandle> {
  const emit = (patch: Partial<UploadHandle>): UploadHandle => {
    Object.assign(handle, patch);
    options.onChange({ ...handle });
    return handle;
  };

  try {
    let session: BeginResponse;
    let alreadyHave = new Set<number>();

    if (handle.uploadPublicId) {
      // A retry of a session that already exists. Ask what arrived before
      // sending anything — this is the whole resumability story.
      const existing = await fetch(`/api/media/uploads/${handle.uploadPublicId}`, {
        signal: options.signal,
      });
      if (existing.ok) {
        const body = (await existing.json()) as { receivedParts: number[] };
        alreadyHave = new Set(body.receivedParts);
      }
    }

    if (!handle.uploadPublicId) {
      emit({ phase: "hashing", error: undefined });
      const checksum = await fileChecksum(handle.file);

      const begun = await fetch("/api/media/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: options.signal,
        body: JSON.stringify({
          filename: handle.file.name,
          bytes: handle.file.size,
          checksum,
          contentType: handle.file.type || "application/octet-stream",
          folderPublicId: options.folderPublicId ?? null,
        }),
      });

      if (!begun.ok) {
        // 413 (too large) and 507 (over quota) are final for this file as it
        // stands: retrying identical bytes will be refused identically.
        const retryable = begun.status !== 413 && begun.status !== 507;
        return emit({
          phase: "failed",
          retryable,
          error: await readError(begun, "That upload could not be started."),
        });
      }

      session = (await begun.json()) as BeginResponse;
      emit({
        uploadPublicId: session.uploadPublicId,
        assetPublicId: session.assetPublicId,
        progress: { fraction: 0, partsSent: 0, partsTotal: session.partCount },
      });
    } else {
      session = {
        ok: true,
        uploadPublicId: handle.uploadPublicId,
        assetPublicId: handle.assetPublicId!,
        partSize: handle.progress.partsTotal
          ? Math.ceil(handle.file.size / handle.progress.partsTotal)
          : handle.file.size,
        partCount: handle.progress.partsTotal || 1,
      };
    }

    emit({ phase: "uploading" });

    let sent = alreadyHave.size;
    for (let part = 1; part <= session.partCount; part += 1) {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (alreadyHave.has(part)) continue;

      const start = (part - 1) * session.partSize;
      const slice = handle.file.slice(
        start,
        Math.min(start + session.partSize, handle.file.size),
      );

      const put = await fetch(
        `/api/media/uploads/${session.uploadPublicId}/parts/${part}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: slice,
          signal: options.signal,
        },
      );

      if (!put.ok) {
        return emit({
          phase: "failed",
          retryable: true,
          error: await readError(
            put,
            "The connection dropped part-way. Retrying will send only what is missing.",
          ),
        });
      }

      sent += 1;
      // Progress counts parts the *server* acknowledged. Counting bytes handed
      // to `fetch` would show 100% while an upload was actually stalled.
      emit({
        progress: {
          partsSent: sent,
          partsTotal: session.partCount,
          fraction: sent / session.partCount,
        },
      });
    }

    emit({ phase: "finishing" });

    const completed = await fetch(`/api/media/uploads/${session.uploadPublicId}`, {
      method: "POST",
      signal: options.signal,
    });

    if (!completed.ok) {
      const body = (await completed.json().catch(() => ({}))) as {
        message?: string;
        retryable?: boolean;
      };
      return emit({
        phase: "failed",
        // 422 means nothing about this file will change on a retry — a HEIC, or
        // bytes that are not an image. 409 means send the missing parts again.
        retryable: body.retryable ?? completed.status === 409,
        error: body.message ?? "That image could not be saved.",
      });
    }

    // Uploaded, not yet usable: derivatives still have to run. The library
    // shows this honestly rather than pretending the image is ready.
    return emit({
      phase: "processing",
      progress: {
        partsSent: session.partCount,
        partsTotal: session.partCount,
        fraction: 1,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return emit({ phase: "failed", retryable: true, error: "Upload cancelled." });
    }
    return emit({
      phase: "failed",
      retryable: true,
      error:
        error instanceof Error
          ? `Upload failed: ${error.message}`
          : "Upload failed.",
    });
  }
}

/** Abandon a session so its parts and placeholder are released now, not at expiry. */
export async function cancelUpload(uploadPublicId: string): Promise<void> {
  try {
    await fetch(`/api/media/uploads/${uploadPublicId}`, { method: "DELETE" });
  } catch {
    // The sweeper collects it either way; failing here would only replace one
    // problem with a second, louder one.
  }
}
