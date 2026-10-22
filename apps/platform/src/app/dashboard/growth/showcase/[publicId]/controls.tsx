"use client";

import { useActionState, useState } from "react";
import {
  deleteShowcaseAction,
  markPostedAction,
  saveWordingAction,
  sendToSiteAction,
  type ShowcaseActionResult,
} from "../actions";

/**
 * The showcase page's buttons. Each posts the showcase's public id only; the
 * action looks it up inside the caller's own organization.
 */

function Result({ state }: { state: ShowcaseActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

/** Edit the draft, save it, or approve it. */
export function WordingForm({
  publicId,
  title,
  writeUp,
  caption,
  readOnly,
}: {
  publicId: string;
  title: string;
  writeUp: string;
  caption: string;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<ShowcaseActionResult | null, FormData>(
    saveWordingAction,
    null,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (
          submitter?.value === "approve" &&
          !window.confirm(
            "Approve this wording? It goes to your website as a change (you see a preview first), your graphics are made, and the Google post is ready. The wording can't be changed after this.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="showcase" value={publicId} />
      <label htmlFor="showcase-title">Title</label>
      <input id="showcase-title" name="title" defaultValue={title} required maxLength={120} disabled={readOnly} />
      <label htmlFor="showcase-writeup">Write-up</label>
      <textarea
        id="showcase-writeup"
        name="writeUp"
        defaultValue={writeUp}
        rows={7}
        required
        maxLength={3000}
        disabled={readOnly}
      />
      <p className="field-hint">For your website page and your Google post.</p>
      <label htmlFor="showcase-caption">Caption for social media</label>
      <textarea
        id="showcase-caption"
        name="caption"
        defaultValue={caption}
        rows={3}
        required
        maxLength={1000}
        disabled={readOnly}
      />
      <Result state={state} />
      <div className="actions">
        <button type="submit" name="intent" value="approve" disabled={readOnly || pending}>
          {pending ? "Working…" : "Approve and publish"}
        </button>
        <button type="submit" name="intent" value="save" className="secondary" disabled={readOnly || pending}>
          Save changes
        </button>
      </div>
    </form>
  );
}

export function SendToSiteButton({ publicId, readOnly }: { publicId: string; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ShowcaseActionResult | null, FormData>(sendToSiteAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="showcase" value={publicId} />
      <Result state={state} />
      <button type="submit" className="small" disabled={readOnly || pending}>
        {pending ? "Sending…" : "Send to my website"}
      </button>
    </form>
  );
}

export function MarkPostedButton({ publicId, readOnly }: { publicId: string; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ShowcaseActionResult | null, FormData>(markPostedAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="showcase" value={publicId} />
      <Result state={state} />
      <button type="submit" className="secondary small" disabled={readOnly || pending}>
        I&rsquo;ve posted it
      </button>
    </form>
  );
}

export function DeleteShowcaseForm({ publicId, readOnly }: { publicId: string; readOnly: boolean }) {
  return (
    <form
      action={deleteShowcaseAction}
      onSubmit={(event) => {
        if (!window.confirm("Remove this from your showcase list? Anything already on your website stays there.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="showcase" value={publicId} />
      <button type="submit" className="linklike" disabled={readOnly}>
        Remove from this list
      </button>
    </form>
  );
}

/** Copy text for pasting into Facebook, Instagram or Google. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  return (
    <button
      type="button"
      className="secondary small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied("yes");
        } catch {
          // Some browsers refuse clipboard access without a secure context;
          // the text is on the page to select by hand.
          setCopied("no");
        }
      }}
    >
      {copied === "yes" ? "Copied" : copied === "no" ? "Select and copy it above" : label}
    </button>
  );
}
