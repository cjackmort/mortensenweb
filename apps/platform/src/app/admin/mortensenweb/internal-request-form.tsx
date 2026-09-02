"use client";

import { useActionState } from "react";
import {
  submitInternalRequestAction,
  cancelInternalRequestAction,
  type InternalRequestResult,
} from "./actions";

function Feedback({ state }: { state: InternalRequestResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <p className="notice notice-success">{state.message}</p>
  ) : (
    <p className="error">{state.message}</p>
  );
}

/**
 * The same fields a client's request form asks for, minus the parts that
 * only make sense against a paid plan — an allowance meter and photo
 * attachments neither apply here, since nobody is billed for this site.
 */
export function InternalRequestForm({ sitePublicId }: { sitePublicId: string }) {
  const [state, formAction, pending] = useActionState<
    InternalRequestResult | null,
    FormData
  >(submitInternalRequestAction, null);

  return (
    <form action={formAction} className="form">
      <Feedback state={state} />

      <input type="hidden" name="sitePublicId" value={sitePublicId} />

      <label htmlFor="title">What do you want changed</label>
      <input
        id="title"
        name="title"
        type="text"
        placeholder="Swap the hero photo on the homepage"
        required
      />

      <label htmlFor="description">Details</label>
      <textarea
        id="description"
        name="description"
        rows={4}
        placeholder="Whatever you'd tell yourself if you were the client asking for this."
      />

      <div className="actions" style={{ flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 10rem" }}>
          <label htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue="other" style={{ marginBottom: 0 }}>
            <option value="content">Content</option>
            <option value="design">Design</option>
            <option value="bug">Bug</option>
            <option value="seo">SEO</option>
            <option value="feature">Feature</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div style={{ flex: "1 1 10rem" }}>
          <label htmlFor="priority">Priority</label>
          <select id="priority" name="priority" defaultValue="normal" style={{ marginBottom: 0 }}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
      </div>

      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Request this change"}
      </button>
    </form>
  );
}

export function InternalCancelButton({
  requestPublicId,
}: {
  requestPublicId: string;
}) {
  const [state, formAction, pending] = useActionState<
    InternalRequestResult | null,
    FormData
  >(cancelInternalRequestAction, null);

  return (
    <form action={formAction}>
      {state && !state.ok && (
        <p className="error" style={{ fontSize: "0.82rem" }}>
          {state.message}
        </p>
      )}
      <input type="hidden" name="requestPublicId" value={requestPublicId} />
      <button
        type="submit"
        className="secondary"
        disabled={pending}
        style={{ width: "auto", minHeight: "auto", padding: "0.2rem 0.6rem", fontSize: "0.8rem" }}
      >
        {pending ? "Cancelling…" : "Cancel"}
      </button>
    </form>
  );
}
