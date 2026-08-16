"use client";

import { useActionState, useRef, useState } from "react";
import {
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/storage";
import { submitChangeRequest, type RequestSubmission } from "./actions";

/**
 * The change-request form.
 *
 * Written for a phone. `capture` is deliberately absent from the file input:
 * adding it forces the camera and removes the photo library, and most requests
 * are about a photo the client already has. `accept` limits the picker to
 * images, which is a convenience — the real check is byte inspection on the
 * server, since `accept` is trivially bypassed.
 *
 * Previews are local object URLs and never uploaded ahead of submit. They exist
 * so someone can tell whether they picked the right photo before sending it,
 * which is the difference between one request and three.
 */

interface SiteOption {
  publicId: string;
  name: string;
}

const CATEGORIES = [
  { value: "content", label: "Text or content change" },
  { value: "design", label: "Design or layout" },
  { value: "bug", label: "Something looks broken" },
  { value: "seo", label: "Search or visibility" },
  { value: "feature", label: "Something new" },
  { value: "other", label: "Something else" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RequestForm({ sites }: { sites: SiteOption[] }) {
  const [state, formAction, pending] = useActionState<
    RequestSubmission | null,
    FormData
  >(submitChangeRequest, null);

  const [previews, setPreviews] = useState<
    { name: string; url: string; size: number }[]
  >([]);
  const formRef = useRef<HTMLFormElement>(null);

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Revoke the previous batch so repeated picking does not leak object URLs.
    previews.forEach((p) => URL.revokeObjectURL(p.url));
    setPreviews(
      files.map((file) => ({
        name: file.name,
        url: URL.createObjectURL(file),
        size: file.size,
      })),
    );
  }

  if (state?.ok) {
    return (
      <div className="card">
        <div className="notice notice-success" style={{ marginBottom: "1rem" }}>
          <strong>Request sent.</strong> We&rsquo;ll pick this up and you&rsquo;ll
          see it in the list below.
          {state.attached > 0 && (
            <>
              {" "}
              {state.attached}{" "}
              {state.attached === 1 ? "photo was" : "photos were"} attached.
            </>
          )}
        </div>

        {state.rejected.length > 0 && (
          <div className="error">
            <strong>
              {state.rejected.length === 1
                ? "One photo was not attached:"
                : "Some photos were not attached:"}
            </strong>
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
              {state.rejected.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p style={{ margin: "0.5rem 0 0" }}>
              The request itself was saved. You can reply to it to add more.
            </p>
          </div>
        )}

        <button
          type="button"
          className="secondary"
          onClick={() => {
            previews.forEach((p) => URL.revokeObjectURL(p.url));
            setPreviews([]);
            formRef.current?.reset();
            // Reload so the list below picks up the new request.
            window.location.reload();
          }}
        >
          Make another request
        </button>
      </div>
    );
  }

  return (
    <form ref={formRef} className="card" action={formAction}>
      <div className="card-head">
        <h2>Request a change</h2>
      </div>

      {state && !state.ok && <p className="error">{state.message}</p>}

      <label htmlFor="title">What would you like changed?</label>
      <input
        id="title"
        name="title"
        type="text"
        placeholder="New photos on the services page"
        required
        minLength={3}
        maxLength={200}
      />

      <label htmlFor="description">Any detail that would help</label>
      <textarea
        id="description"
        name="description"
        placeholder="Where it is, what it should say, anything we should know."
      />

      {sites.length > 1 && (
        <>
          <label htmlFor="sitePublicId">Which site?</label>
          <select id="sitePublicId" name="sitePublicId">
            {sites.map((site) => (
              <option key={site.publicId} value={site.publicId}>
                {site.name}
              </option>
            ))}
          </select>
        </>
      )}
      {sites.length === 1 && (
        <input type="hidden" name="sitePublicId" value={sites[0]!.publicId} />
      )}

      <label htmlFor="category">What kind of change?</label>
      <select id="category" name="category" defaultValue="content">
        {CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <label className="checkbox">
        <input type="checkbox" name="priority" value="high" />
        <span>This one is urgent</span>
      </label>

      <label htmlFor="photos">Photos (optional)</label>
      <input
        id="photos"
        name="photos"
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        onChange={onPick}
      />
      <p className="field-hint">
        Up to {MAX_ATTACHMENTS_PER_REQUEST} images,{" "}
        {Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB each. JPEG, PNG, GIF,
        or WebP — a photo straight from your phone is fine.
      </p>

      {previews.length > 0 && (
        <div className="preview-grid">
          {previews.map((preview) => (
            <figure key={preview.url} className="preview">
              {/* Local object URL, not yet uploaded. next/image cannot
                  optimise a blob: URL, so a plain img is correct here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview.url} alt="" />
              <figcaption>
                {preview.name}
                <span>{formatBytes(preview.size)}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
