"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { statusLabel } from "@/lib/requests/status";
import { submitChangeRequest, type RequestSubmission } from "./actions";
import {
  AssetPicker,
  type PickableAsset,
  type PickableFolder,
} from "./asset-picker";

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
              <a href="/dashboard/billing">Buy one more</a> for{" "}
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

/** Where an unsent draft lives between visits. Per browser, per client. */
const DRAFT_KEY = "mw.request-draft.v1";

interface Draft {
  title: string;
  description: string;
  assetPublicIds: string[];
  idempotencyKey: string;
}

function loadDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed.idempotencyKey !== "string") return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
      assetPublicIds: Array.isArray(parsed.assetPublicIds)
        ? parsed.assetPublicIds.filter((x): x is string => typeof x === "string")
        : [],
      idempotencyKey: parsed.idempotencyKey,
    };
  } catch {
    // A private window, cleared storage, or a value from an older shape. A
    // missing draft is the ordinary case, not an error worth surfacing.
    return null;
  }
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function RequestForm({
  sites,
  allowance,
  locked,
  assets,
  folders,
}: {
  sites: SiteOption[];
  allowance: AllowanceSummary | null;
  /** True until the first payment clears. The form is replaced, not disabled. */
  locked: boolean;
  /** Ready images from the media library, to choose from. */
  assets: PickableAsset[];
  folders: PickableFolder[];
}) {
  const [state, formAction, pending] = useActionState<
    RequestSubmission | null,
    FormData
  >(submitChangeRequest, null);

  const formRef = useRef<HTMLFormElement>(null);

  const exhausted = Boolean(
    state && !state.ok && state.reason === "allowance_exhausted",
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);

  /**
   * One key per composed request, minted once and kept until it is sent.
   *
   * This is what makes submitting idempotent. A double-tap, a browser retrying
   * a request it was unsure about, and a client pressing Send again after a
   * slow response all carry the same value — so the server finds the request it
   * already created instead of making a second one and charging for it.
   *
   * It lives in the draft, so it also survives a reload mid-submit: the case
   * where someone gives up waiting, refreshes, and sends again.
   */
  const [idempotencyKey, setIdempotencyKey] = useState("");
  /** True when this form opened onto text the client had not sent. */
  const [restored, setRestored] = useState(false);

  /*
   * Restore an unsent draft.
   *
   * This has to be an effect, and it has to set state, which is the one thing
   * `react-hooks/set-state-in-effect` exists to discourage. The rule is right
   * in general and does not fit here: `localStorage` does not exist during the
   * server render, so a lazy `useState` initialiser would either throw on the
   * server or return different values on the two sides and break hydration.
   * Reading it after mount and setting state once is the documented way to
   * bring a browser-only value into React.
   *
   * It runs once, on mount, with an empty dependency list — so the "cascading
   * renders" the rule guards against amount to exactly one extra render on
   * first paint.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      setTitle(draft.title);
      setDescription(draft.description);
      setSelectedAssets(draft.assetPublicIds);
      setIdempotencyKey(draft.idempotencyKey);
      setRestored(Boolean(draft.title || draft.description));
    } else {
      setIdempotencyKey(newIdempotencyKey());
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keep the draft current as they type.
  //
  // Losing typed input is the failure this whole change is about, and the
  // upload path fixes only the version of it caused by request size. A crashed
  // tab, a phone killing a background page, or a hard refresh are all still
  // there — and this is what makes those survivable too.
  useEffect(() => {
    if (!idempotencyKey) return;
    if (!title && !description && selectedAssets.length === 0) return;
    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ title, description, assetPublicIds: selectedAssets, idempotencyKey }),
      );
    } catch {
      // Storage full, or blocked. The form still works; only the safety net is
      // missing, and telling someone about it mid-sentence would not help.
    }
  }, [title, description, selectedAssets, idempotencyKey]);

  // Sent successfully: the draft has served its purpose and must not be
  // restored on the next visit as though it were unsent.
  useEffect(() => {
    if (!state?.ok) return;
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing to do, and nothing depends on it.
    }
  }, [state?.ok]);

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
            setTitle("");
            setDescription("");
            setSelectedAssets([]);
            // A new request is a new submission, so it needs its own key —
            // reusing the sent one would make the next request look like a
            // retry of the last and be answered with it.
            setIdempotencyKey(newIdempotencyKey());
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

      {/* Minted once per composed request. The server uses it to recognise a
          retry, so a double-tap or a network retry cannot create a second
          request or spend a second change. */}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

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
                <a href="/dashboard/billing">Buy one more change</a> for{" "}
                {formatMoney(state.overagePerChangeCents)} and send this right
                after, or{" "}
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
      ) : state && !state.ok && state.reason === "one_at_a_time" ? (
        /* Also not an error. They have done nothing wrong, and the answer is
           "finish or cancel that one first" — so it names the request that is
           in the way rather than leaving them to work it out from a list. */
        <div className="notice">
          <p style={{ marginTop: 0 }}>
            <strong>{state.message}</strong>
          </p>
          <p style={{ marginBottom: 0 }}>
            In progress:{" "}
            <a href={`#request-${state.openRequest.publicId}`}>
              {state.openRequest.title}
            </a>{" "}
            <span className="muted">
              &mdash; {statusLabel(state.openRequest.status)}
            </span>
            . Finish that one, or cancel it, and you can send this straight
            after.
          </p>
        </div>
      ) : (
        state && !state.ok && <p className="error">{state.message}</p>
      )}

      {/* Suppressed once the refusal notice is up: it carries the same figures
          and the same offer, and showing both says it twice in a row. */}
      {allowance && !exhausted && <AllowanceMeter allowance={allowance} />}

      {/* Said out loud, because text reappearing unannounced reads as a bug
          rather than as the safety net it is. */}
      {restored && (
        <p className="notice">
          We kept what you were writing last time. Change anything you like, or{" "}
          <button
            type="button"
            className="linklike"
            onClick={() => {
              setTitle("");
              setDescription("");
              setSelectedAssets([]);
              setRestored(false);
            }}
          >
            start again
          </button>
          .
        </p>
      )}

      <label htmlFor="title">What would you like changed?</label>
      <input
        id="title"
        name="title"
        type="text"
        placeholder="New photos on the services page"
        required
        minLength={3}
        maxLength={200}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <label htmlFor="description">Tell us what you want</label>
      <textarea
        id="description"
        name="description"
        rows={7}
        placeholder="Describe it however you'd say it out loud. Where it is, what it should say, what you don't like about it now — as much or as little as you want."
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <p className="field-hint">
        No need to be technical. We&rsquo;ll work out the details and send you a
        preview before anything changes on your site.
      </p>

      {/* One site is the normal case, so the picker only appears when the
          choice is real. Two questions where one has a single possible answer
          is a form that feels longer than it is. */}
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

      {/* Category and priority are gone from the form.
          
          Both asked the client to classify their own request, which is our job
          and not theirs — someone who wants a phone number changed should not
          have to decide whether that is "content" or "a bug", and every one of
          those choices is a chance to stall. The agent reads what they wrote
          and works it out, which is what it is for. `category` defaults to
          `other` server-side and nothing downstream branches on it. */}

      <label htmlFor="media-picker-label">Images (optional)</label>
      <p id="media-picker-label" className="field-hint">
        Choose from your media library. Photos are uploaded there separately, at
        full quality, so sending a request never waits on an upload and never
        fails because of one.
      </p>

      <AssetPicker
        assets={assets}
        folders={folders}
        selected={selectedAssets}
        onChange={setSelectedAssets}
      />

      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
