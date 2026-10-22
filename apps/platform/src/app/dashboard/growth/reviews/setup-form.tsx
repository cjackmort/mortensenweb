"use client";

import { useActionState } from "react";
import type { ReviewResult } from "@/db/repositories/client/reviews";
import { findPlacesAction, saveReviewLinkAction, type PlaceSearchResult } from "./actions";

/**
 * The one-time setup: where the "Leave a review" button sends customers.
 *
 * With the Places API switched on, the business types its name and picks
 * itself from Google's answer. Either way it can paste the link Google
 * Business Profile gives it under "Ask for reviews", or a place ID. The
 * server checks whatever arrives; nothing here is trusted.
 */
export function ReviewLinkForm({
  current,
  placesEnabled,
  readOnly,
}: {
  current: string | null;
  placesEnabled: boolean;
  readOnly: boolean;
}) {
  const [saved, saveAction, saving] = useActionState<ReviewResult | null, FormData>(saveReviewLinkAction, null);
  const [found, findAction, finding] = useActionState<PlaceSearchResult | null, FormData>(findPlacesAction, null);

  return (
    <div className="review-setup">
      {saved && (
        <p className={saved.ok ? "notice notice-success" : "error"} role="status">
          {saved.message}
        </p>
      )}

      {placesEnabled && (
        <>
          <form action={findAction}>
            <label htmlFor="review-place-query">Find your business on Google</label>
            <input
              id="review-place-query"
              name="query"
              placeholder="Business name and town"
              defaultValue={found?.ok ? found.query : ""}
              disabled={readOnly || finding}
              required
            />
            <button type="submit" className="secondary" disabled={readOnly || finding}>
              {finding ? "Searching…" : "Search Google"}
            </button>
          </form>
          {found && !found.ok && <p className="error">{found.message}</p>}
          {found?.ok && (
            <ul className="review-places">
              {found.places.map((place) => (
                <li key={place.placeId}>
                  <form action={saveAction}>
                    <input type="hidden" name="link" value={place.placeId} />
                    <span>
                      <strong>{place.name}</strong>
                      {place.address && <span className="muted"> · {place.address}</span>}
                    </span>
                    <button type="submit" disabled={readOnly || saving}>
                      This is us
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <p className="review-or">Or paste it yourself</p>
        </>
      )}

      <form action={saveAction}>
        <label htmlFor="review-link">Your Google review link</label>
        <input
          id="review-link"
          name="link"
          defaultValue={current ?? ""}
          placeholder="https://g.page/r/…/review"
          disabled={readOnly || saving}
          required
        />
        <p className="field-hint">
          In your Google Business Profile, choose <strong>Ask for reviews</strong> and copy the link. Your
          Google place ID works too —{" "}
          <a
            href="https://developers.google.com/maps/documentation/places/web-service/place-id"
            target="_blank"
            rel="noreferrer"
          >
            find it here
          </a>
          .
        </p>
        <button type="submit" disabled={readOnly || saving}>
          {saving ? "Saving…" : "Save link"}
        </button>
      </form>
    </div>
  );
}
