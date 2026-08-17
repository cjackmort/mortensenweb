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

export interface AllowanceSummary {
  /** Null means unlimited. */
  included: number | null;
  used: number;
  remaining: number | null;
  label: string;
  overagePerChangeCents: number | null;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    // Whole dollars read better on a price than "$39.00" does.
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/**
 * "2 of 3 changes left this month."
 *
 * Shown before someone starts typing, not after they submit. Discovering the
 * limit at the point of sending — having already written the request and picked
 * the photos — is the version of this that makes people angry.
 */
function AllowanceMeter({ allowance }: { allowance: AllowanceSummary }) {
  if (allowance.included === null) {
    return (
      <p className="field-hint">
        Your plan includes unlimited changes. You&rsquo;ve sent{" "}
        {allowance.used} this month.
      </p>
    );
  }

  const remaining = allowance.remaining ?? 0;

  return (
    <p className={remaining === 0 ? "notice" : "field-hint"}>
      {remaining === 0 ? (
        <>
          You&rsquo;ve used all {allowance.included}{" "}
          {allowance.included === 1 ? "change" : "changes"} included in{" "}
          {allowance.label}.
          {allowance.overagePerChangeCents !== null && (
            <>
              {" "}
              You can still send this one for{" "}
              {formatMoney(allowance.overagePerChangeCents)}, or move to a plan
              with more included.
            </>
          )}
        </>
      ) : (
        <>
          {remaining} of {allowance.included}{" "}
          {allowance.included === 1 ? "change" : "changes"} left in{" "}
          {allowance.label}.
        </>
      )}
    </p>
  );
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

export function RequestForm({
  sites,
  allowance,
  locked,
}: {
  sites: SiteOption[];
  allowance: AllowanceSummary | null;
  /** True until the first payment clears. The form is replaced, not disabled. */
  locked: boolean;
}) {
  const [state, formAction, pending] = useActionState<
    RequestSubmission | null,
    FormData
  >(submitChangeRequest, null);

  const [previews, setPreviews] = useState<
    { name: string; url: string; size: number }[]
  >([]);
  const formRef = useRef<HTMLFormElement>(null);

  const exhausted = Boolean(
    state && !state.ok && state.reason === "allowance_exhausted",
  );

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

  // Locked replaces the form rather than disabling it. A greyed-out form with
  // an explanation underneath still invites someone to fill it in and find out
  // it does not work.
  if (locked) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>Request a change</h2>
        </div>
        <div className="notice">
          <p style={{ marginTop: 0 }}>
            <strong>Change requests unlock once your first payment goes
            through.</strong>
          </p>
          <p style={{ marginBottom: 0 }}>
            Head to <a href="/dashboard/billing">Billing</a> to get set up — it
            takes a minute, and everything opens up straight afterwards.
          </p>
        </div>
      </div>
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
          {typeof state.remaining === "number" && (
            <>
              {" "}
              You have {state.remaining}{" "}
              {state.remaining === 1 ? "change" : "changes"} left this month.
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

      {/* An exhausted allowance is an offer, not an error. Same information,
          completely different tone — the client has done nothing wrong. */}
      {exhausted && state && !state.ok && "overagePerChangeCents" in state ? (
        <div className="notice">
          <p style={{ marginTop: 0 }}>
            <strong>{state.message}</strong>
          </p>
          <p style={{ marginBottom: 0 }}>
            {state.overagePerChangeCents !== null ? (
              <>
                You can send this one for{" "}
                {formatMoney(state.overagePerChangeCents)}, or{" "}
                <a href="/dashboard/billing">move to a bigger plan</a> if
                you&rsquo;re making changes often.
              </>
            ) : (
              <>
                <a href="/dashboard/billing">Upgrading your plan</a> will give
                you more each month.
              </>
            )}
          </p>
        </div>
      ) : (
        state && !state.ok && <p className="error">{state.message}</p>
      )}

      {/* Suppressed once the refusal notice is up: it carries the same figures
          and the same offer, and showing both says it twice in a row. */}
      {allowance && !exhausted && <AllowanceMeter allowance={allowance} />}

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
