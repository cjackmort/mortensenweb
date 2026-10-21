"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Uploader } from "../../../media/uploader";
import { createShowcaseAction, type ShowcaseActionResult } from "../actions";

/**
 * Photos and a few words.
 *
 * Photos come from the media library, newest first, and new ones can be
 * uploaded right here through the library's own uploader — they land in the
 * library, appear in the grid, and are picked like any other. The order they
 * are ticked in is the order they are shown in, and the number on each tile
 * says so.
 *
 * The before-and-after pairing is optional and is chosen from the photos
 * already picked, so it can never name a photo that is not in the showcase.
 */

export interface PickablePhoto {
  publicId: string;
  title: string;
  ready: boolean;
  hasThumbnail: boolean;
}

/** How long to wait before looking again for photos still being prepared. */
const PROCESSING_RECHECK_MS = 4000;

export function NewShowcaseForm({
  photos,
  sites,
  maxPhotos,
  readOnly,
}: {
  photos: PickablePhoto[];
  sites: { publicId: string; name: string }[];
  maxPhotos: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ShowcaseActionResult | null, FormData>(
    createShowcaseAction,
    null,
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [pairing, setPairing] = useState(false);
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [uploading, setUploading] = useState(false);

  const processing = photos.some((p) => !p.ready);
  useEffect(() => {
    if (!processing) return;
    const timer = setTimeout(() => router.refresh(), PROCESSING_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [processing, photos, router]);

  function toggle(publicId: string) {
    if (chosen.includes(publicId)) {
      if (before === publicId) setBefore("");
      if (after === publicId) setAfter("");
      setChosen(chosen.filter((id) => id !== publicId));
    } else if (chosen.length < maxPhotos) {
      setChosen([...chosen, publicId]);
    }
  }

  const titleOf = (id: string) => photos.find((p) => p.publicId === id)?.title ?? "Photo";

  return (
    <form action={formAction} className="showcase-form">
      <section className="panel">
        <div className="panel-head">
          <h2>1. Photos of the job</h2>
          <span className="muted">
            {chosen.length === 0 ? `Up to ${maxPhotos}` : `${chosen.length} chosen`}
          </span>
        </div>
        <div className="panel-body">
          {photos.length === 0 && !uploading ? (
            <p className="field-hint">No photos in your library yet. Upload some below.</p>
          ) : (
            <ul className="media-picker-grid showcase-picker">
              {photos.map((photo) => {
                const index = chosen.indexOf(photo.publicId);
                const isChosen = index >= 0;
                return (
                  <li key={photo.publicId}>
                    <label
                      className={`media-picker-tile${isChosen ? " is-selected" : ""}${photo.ready ? "" : " is-waiting"}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChosen}
                        disabled={!photo.ready || readOnly}
                        onChange={() => toggle(photo.publicId)}
                        aria-label={photo.title}
                      />
                      {isChosen && <span className="showcase-pick-order" aria-hidden="true">{index + 1}</span>}
                      {photo.hasThumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/media/assets/${photo.publicId}/thumb`} alt="" loading="lazy" />
                      ) : (
                        <span className="showcase-pick-blank" aria-hidden="true" />
                      )}
                      <span title={photo.title}>{photo.ready ? photo.title : "Getting ready…"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {chosen.map((id) => (
            <input key={id} type="hidden" name="photo" value={id} />
          ))}

          {!readOnly && (
            <div className="showcase-upload">
              {uploading ? (
                <Uploader folderPublicId={null} folderLabel="your library" onUploaded={() => router.refresh()} />
              ) : (
                <button type="button" className="secondary small" onClick={() => setUploading(true)}>
                  Upload new photos
                </button>
              )}
              <p className="field-hint">New photos go into your media library too.</p>
            </div>
          )}

          {chosen.length >= 2 && (
            <fieldset className="showcase-pair">
              <label className="showcase-check">
                <input
                  type="checkbox"
                  checked={pairing}
                  onChange={(event) => {
                    setPairing(event.target.checked);
                    if (!event.target.checked) {
                      setBefore("");
                      setAfter("");
                    }
                  }}
                />
                Show a before and after
              </label>
              {pairing && (
                <div className="showcase-pair-pick">
                  <label>
                    Before
                    <select name="before" value={before} onChange={(e) => setBefore(e.target.value)} required>
                      <option value="">Choose…</option>
                      {chosen.map((id) => (
                        <option key={id} value={id} disabled={id === after}>
                          {chosen.indexOf(id) + 1}. {titleOf(id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    After
                    <select name="after" value={after} onChange={(e) => setAfter(e.target.value)} required>
                      <option value="">Choose…</option>
                      {chosen.map((id) => (
                        <option key={id} value={id} disabled={id === before}>
                          {chosen.indexOf(id) + 1}. {titleOf(id)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </fieldset>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>2. A few words</h2>
        </div>
        <div className="panel-body">
          <label htmlFor="showcase-job">What was the job?</label>
          <input
            id="showcase-job"
            name="job"
            required
            maxLength={160}
            disabled={readOnly}
            placeholder="Replaced a 20-year-old furnace"
          />
          <label htmlFor="showcase-town">Which town?</label>
          <input id="showcase-town" name="town" required maxLength={60} disabled={readOnly} placeholder="Riverton" />
          <label htmlFor="showcase-notes">Anything else worth saying? (optional)</label>
          <textarea
            id="showcase-notes"
            name="notes"
            rows={3}
            maxLength={600}
            disabled={readOnly}
            placeholder="What made it tricky, what the customer wanted, how it turned out."
          />
          {sites.length > 1 && (
            <>
              <label htmlFor="showcase-site">Which website should the page go on?</label>
              <select id="showcase-site" name="sitePublicId" required disabled={readOnly} defaultValue="">
                <option value="">Choose…</option>
                {sites.map((site) => (
                  <option key={site.publicId} value={site.publicId}>
                    {site.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <p className="field-hint">
            We draft a title and a short write-up from your words and your business details. Nothing else is
            added, and you check it before anything is published.
          </p>

          {state && !state.ok && (
            <p className="error" role="status">
              {state.message}
            </p>
          )}
          <button type="submit" disabled={readOnly || pending || chosen.length === 0}>
            {pending ? "Drafting…" : "Draft the write-up"}
          </button>
        </div>
      </section>
    </form>
  );
}
