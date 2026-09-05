"use client";

import { useActionState, useState } from "react";
import {
  approveAndApply,
  requestMoreChanges,
  type ApplyResult,
} from "./preview-actions";
import { CancelRequestButton } from "./cancel-button";

/**
 * "Here's your change — have a look."
 *
 * The moment the client decides whether something goes live on their website.
 * A few things about it are deliberate.
 *
 * **The link opens in a new tab.** They are going to look, come back, and
 * click. Navigating away from the approval control and asking them to find
 * their way back is how approvals get abandoned half-finished.
 *
 * **Approve is not the default-styled action until they've had a chance to
 * look.** The preview link comes first in the reading order and visually
 * dominates; the buttons sit under it.
 *
 * **"Ask for changes" is offered with equal prominence.** If the only easy path
 * is Approve, people approve things they are unsure about and raise it later as
 * a complaint. Making the other answer just as easy produces better websites
 * and fewer awkward conversations.
 */

export interface PreviewItem {
  requestPublicId: string;
  requestTitle: string;
  previewUrl: string;
  /** The agent's description of the change, for a non-technical reader. */
  summary?: string | null;
}

function PreviewCard({ item }: { item: PreviewItem }) {
  const [approveState, approveAction, approving] = useActionState<
    ApplyResult | null,
    FormData
  >(approveAndApply, null);

  const [changesState, changesAction, requesting] = useActionState<
    ApplyResult | null,
    FormData
  >(requestMoreChanges, null);

  const [showNote, setShowNote] = useState(false);

  const settled = approveState?.ok || changesState?.ok;

  if (settled) {
    const message = approveState?.ok
      ? approveState.message
      : changesState?.ok
        ? changesState.message
        : "";
    return (
      <div className="notice notice-success">
        <strong>{item.requestTitle}</strong>
        <p style={{ margin: "0.35rem 0 0" }}>{message}</p>
      </div>
    );
  }

  return (
    <div className="request-item">
      <div className="request-head">
        <p className="request-title">{item.requestTitle}</p>
        <span className="pill pill-accent">ready to review</span>
      </div>

      <p style={{ margin: "0.5rem 0 0.75rem" }}>
        We&rsquo;ve made this change on a preview of your site. Take a look, and
        if you&rsquo;re happy we&rsquo;ll put it live.
      </p>

      {item.summary && (
        <div className="timeline-summary">
          <p className="timeline-summary-label">What we changed</p>
          <p className="timeline-summary-body">{item.summary}</p>
        </div>
      )}

      {/* The change as a picture, straight from the preview deploy — the
          deploy workflow screenshots the home page at phone width and ships
          it inside the preview at a known path. A client on a phone can
          often decide from this without leaving the portal. Hidden, not
          broken, when a site built before that workflow has no screenshot. */}
      <PreviewShot previewUrl={item.previewUrl} title={item.requestTitle} />

      <p>
        <a
          className="button"
          href={item.previewUrl}
          target="_blank"
          // noopener/noreferrer on a target=_blank link to a site we host but do
          // not control the content of after an agent has edited it.
          rel="noopener noreferrer"
        >
          Open the preview
        </a>
      </p>

      {approveState && !approveState.ok && (
        <p className="error">{approveState.message}</p>
      )}
      {changesState && !changesState.ok && (
        <p className="error">{changesState.message}</p>
      )}

      <div className="actions">
        <form action={approveAction}>
          <input
            type="hidden"
            name="requestPublicId"
            value={item.requestPublicId}
          />
          <button type="submit" disabled={approving || requesting}>
            {approving ? "Putting it live…" : "Looks good — put it live"}
          </button>
        </form>

        {!showNote && (
          <button
            type="button"
            className="secondary"
            onClick={() => setShowNote(true)}
            disabled={approving || requesting}
          >
            Ask for changes
          </button>
        )}
      </div>

      {/* The third answer.
          
          Approve and ask-for-changes both assume the client still wants the
          change. "Never mind" is a real answer to a preview and it belongs
          here, beside the other two — a cancel control further down the page,
          below the form, is one a client looking at their preview will not
          find. Until now they had no way to withdraw a request from the screen
          where they had just decided against it, and the one-per-site rule then
          blocked them from raising anything else. */}
      {!showNote && (
        <CancelRequestButton
          requestPublicId={item.requestPublicId}
          hasPreview
        />
      )}

      {showNote && (
        <form action={changesAction} style={{ marginTop: "0.75rem" }}>
          <input
            type="hidden"
            name="requestPublicId"
            value={item.requestPublicId}
          />
          <label htmlFor={`note-${item.requestPublicId}`}>
            What would you like different?
          </label>
          <textarea
            id={`note-${item.requestPublicId}`}
            name="note"
            placeholder="The heading should say… / can the photo be bigger…"
          />
          {/* Stated explicitly: people hold back corrections when they think
              each one costs them, and the result is a site they are quietly
              unhappy with. */}
          <p className="field-hint">
            This won&rsquo;t use up another of your monthly changes — it&rsquo;s
            part of the same request.
          </p>
          <div className="actions">
            <button type="submit" disabled={requesting}>
              {requesting ? "Sending…" : "Send these notes"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowNote(false)}
              disabled={requesting}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PreviewShot({ previewUrl, title }: { previewUrl: string; title: string }) {
  const [available, setAvailable] = useState(true);
  if (!available) return null;
  const src = `${previewUrl.replace(/\/$/, "")}/__preview/home-390.png`;
  return (
    <figure className="preview-shot">
      {/* eslint-disable-next-line @next/next/no-img-element -- a cross-origin
          image on the preview deploy; next/image would proxy it for nothing */}
      <img
        src={src}
        alt={`The home page of your site with "${title}" applied, at phone size`}
        loading="lazy"
        onError={() => setAvailable(false)}
      />
      <figcaption className="muted">How the home page looks with this change.</figcaption>
    </figure>
  );
}

export function PreviewPanel({ items }: { items: PreviewItem[] }) {
  if (items.length === 0) return null;

  return (
    // The anchor the dashboard's "waiting on you" banner links to. Named rather
    // than positional so the banner keeps landing here if the page is reordered.
    // `scroll-margin-top` keeps the heading clear of the sticky header instead
    // of jumping to it and hiding it.
    <section className="card" id="awaiting-approval" style={{ scrollMarginTop: "1.5rem" }}>
      <div className="card-head">
        <h2>Ready for you to look at</h2>
        <span className="muted">{items.length}</span>
      </div>
      {items.map((item) => (
        <PreviewCard key={item.requestPublicId} item={item} />
      ))}
    </section>
  );
}
