"use client";

import { useActionState, useState } from "react";
import {
  holdPreviewAction,
  releasePreviewAction,
  type ReleaseResult,
} from "./actions";

/**
 * Previews waiting on you before a client sees them.
 *
 * Temporary, while the agents are still earning trust. The client should not be
 * the person who discovers a change came out wrong — that costs confidence
 * which is slow to win back, and the cost of looking first is a minute.
 *
 * Open-the-preview leads and dominates. Releasing without looking is the whole
 * failure mode this exists to prevent, so the link is the first thing and the
 * buttons sit beneath it.
 */

export interface PendingRelease {
  agentJobPublicId: string;
  requestPublicId: string;
  requestTitle: string;
  organizationName: string;
  previewUrl: string;
  builtAt: string | null;
}

function ReleaseCard({ item }: { item: PendingRelease }) {
  const [releaseState, releaseAction, releasing] = useActionState<
    ReleaseResult | null,
    FormData
  >(releasePreviewAction, null);

  const [holdState, holdAction, holding] = useActionState<
    ReleaseResult | null,
    FormData
  >(holdPreviewAction, null);

  const [showHold, setShowHold] = useState(false);

  if (releaseState?.ok || holdState?.ok) {
    return (
      <div className="notice notice-success">
        <strong>{item.requestTitle}</strong>
        <p style={{ margin: "0.35rem 0 0" }}>
          {releaseState?.ok ? releaseState.message : holdState?.message}
        </p>
      </div>
    );
  }

  return (
    <div className="request-item">
      <div className="request-head">
        <p className="request-title">{item.requestTitle}</p>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {item.organizationName}
        </span>
      </div>

      <p style={{ margin: "0.5rem 0 0.75rem" }}>
        <a
          className="button"
          href={item.previewUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the preview
        </a>
      </p>

      {releaseState && !releaseState.ok && (
        <p className="error">{releaseState.message}</p>
      )}
      {holdState && !holdState.ok && <p className="error">{holdState.message}</p>}

      <div className="actions">
        <form action={releaseAction}>
          <input
            type="hidden"
            name="agentJobPublicId"
            value={item.agentJobPublicId}
          />
          <button type="submit" disabled={releasing || holding}>
            {releasing ? "Sending…" : "Send to the client"}
          </button>
        </form>

        {!showHold && (
          <button
            type="button"
            className="secondary"
            onClick={() => setShowHold(true)}
            disabled={releasing || holding}
          >
            Hold it back
          </button>
        )}
      </div>

      {showHold && (
        <form action={holdAction} style={{ marginTop: "0.75rem" }}>
          <input
            type="hidden"
            name="agentJobPublicId"
            value={item.agentJobPublicId}
          />
          <label htmlFor={`hold-${item.agentJobPublicId}`}>
            What is wrong with it?
          </label>
          <textarea
            id={`hold-${item.agentJobPublicId}`}
            name="reason"
            placeholder="Wrong photo / broke the nav on mobile / copy is off…"
          />
          {/* Internal only. Telling a client that something they never saw was
              rejected raises a worry rather than settling one. */}
          <p className="field-hint">
            Recorded for you, not shown to the client — they have not seen this
            preview.
          </p>
          <div className="actions">
            <button type="submit" disabled={holding}>
              {holding ? "Holding…" : "Hold it"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowHold(false)}
              disabled={holding}
            >
              Never mind
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function ReleasePanel({ items }: { items: PendingRelease[] }) {
  if (items.length === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Waiting for you to check</h2>
        <span className="pill pill-warning">{items.length}</span>
      </div>
      <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
        The client cannot see these yet. Open each one, and send it on only if
        you would be happy for them to look at it.
      </p>
      {items.map((item) => (
        <ReleaseCard key={item.agentJobPublicId} item={item} />
      ))}
    </section>
  );
}
