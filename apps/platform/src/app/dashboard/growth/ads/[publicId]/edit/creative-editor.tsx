"use client";

import { useActionState, useState } from "react";
import { AdPreview } from "@/components/ads/ad-preview";
import {
  CALLS_TO_ACTION,
  DESCRIPTION_MAX,
  HEADLINE_MAX,
  MAX_DESCRIPTIONS,
  MAX_HEADLINES,
  creativeProblems,
  unsupportedClaims,
  type CallToAction,
} from "@/lib/ads/creative";
import { saveCreativeAction, type CreativeState } from "../../actions";

export interface EditorImage {
  publicId: string;
  title: string | null;
}

/**
 * The ad's words, photo and landing page, with the rules checked as the
 * client types and the ad previewed beside them.
 *
 * The checks here are the same functions the server runs before checkout, so
 * what this page says is fine is what checkout accepts.
 */
export function CreativeEditor({
  campaign,
  businessName,
  initial,
  facts,
  images,
  readOnly,
}: {
  campaign: string;
  businessName: string;
  initial: {
    name: string;
    headlines: string[];
    descriptions: string[];
    callToAction: CallToAction | null;
    finalUrl: string | null;
    phone: string | null;
    targetAreas: string[];
    imageAssetPublicId: string | null;
  };
  facts: Record<string, string>;
  images: EditorImage[];
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState<CreativeState | null, FormData>(saveCreativeAction, null);

  const pad = (values: string[], n: number) => [...values, ...Array(Math.max(0, n - values.length)).fill("")];
  const [headlines, setHeadlines] = useState<string[]>(pad(initial.headlines, MAX_HEADLINES));
  const [descriptions, setDescriptions] = useState<string[]>(pad(initial.descriptions, MAX_DESCRIPTIONS));
  const [cta, setCta] = useState<CallToAction>(initial.callToAction ?? "learn_more");
  const [finalUrl, setFinalUrl] = useState(initial.finalUrl ?? "");
  const [image, setImage] = useState(initial.imageAssetPublicId ?? "");

  const filled = {
    headlines: headlines.map((h) => h.trim()).filter(Boolean),
    descriptions: descriptions.map((d) => d.trim()).filter(Boolean),
  };
  const problems = creativeProblems({ ...filled, finalUrl: finalUrl.trim() || null });
  const claims = unsupportedClaims([...filled.headlines, ...filled.descriptions].join(" "), facts);

  return (
    <form action={formAction} className="ad-editor">
      <input type="hidden" name="campaign" value={campaign} />

      <div className="ad-editor-fields">
        <fieldset disabled={readOnly || pending}>
          <label htmlFor="ad-name">Name for this ad</label>
          <input id="ad-name" name="name" defaultValue={initial.name} maxLength={80} required />
          <p className="field-hint">Only you and we see this.</p>

          <fieldset className="ad-lines">
            <legend>Headlines</legend>
            <p className="field-hint">
              Three to five short lines. Google mixes and matches them, so each should make sense on its own.
            </p>
            {headlines.map((value, i) => (
              <div className="ad-line" key={`h${i}`}>
                <label className="sr-only" htmlFor={`headline-${i}`}>
                  Headline {i + 1}
                </label>
                <input
                  id={`headline-${i}`}
                  name="headline"
                  value={value}
                  maxLength={60}
                  placeholder={i < 3 ? `Headline ${i + 1}` : `Headline ${i + 1} (optional)`}
                  aria-invalid={value.length > HEADLINE_MAX || undefined}
                  onChange={(e) => setHeadlines(headlines.map((h, j) => (j === i ? e.target.value : h)))}
                />
                <span className="ad-count" data-over={value.length > HEADLINE_MAX || undefined}>
                  {value.length}/{HEADLINE_MAX}
                </span>
              </div>
            ))}
          </fieldset>

          <fieldset className="ad-lines">
            <legend>Descriptions</legend>
            {descriptions.map((value, i) => (
              <div className="ad-line" key={`d${i}`}>
                <label className="sr-only" htmlFor={`description-${i}`}>
                  Description {i + 1}
                </label>
                <textarea
                  id={`description-${i}`}
                  name="description"
                  rows={2}
                  value={value}
                  maxLength={180}
                  placeholder={`Description ${i + 1}`}
                  aria-invalid={value.length > DESCRIPTION_MAX || undefined}
                  onChange={(e) => setDescriptions(descriptions.map((d, j) => (j === i ? e.target.value : d)))}
                />
                <span className="ad-count" data-over={value.length > DESCRIPTION_MAX || undefined}>
                  {value.length}/{DESCRIPTION_MAX}
                </span>
              </div>
            ))}
          </fieldset>

          <label htmlFor="ad-cta">Button</label>
          <select
            id="ad-cta"
            name="callToAction"
            value={cta}
            onChange={(e) => setCta(e.target.value as CallToAction)}
          >
            {Object.entries(CALLS_TO_ACTION).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="ad-url">Where a click goes</label>
          <input
            id="ad-url"
            name="finalUrl"
            type="url"
            inputMode="url"
            value={finalUrl}
            placeholder="https://"
            onChange={(e) => setFinalUrl(e.target.value)}
          />

          <label htmlFor="ad-phone">Phone number for the call button</label>
          <input id="ad-phone" name="phone" type="tel" defaultValue={initial.phone ?? ""} />
          <p className="field-hint">Google doesn&rsquo;t allow phone numbers in the ad text, so it goes on the button.</p>

          <label htmlFor="ad-areas">Where to show it</label>
          <input id="ad-areas" name="targetAreas" defaultValue={initial.targetAreas.join(", ")} />
          <p className="field-hint">Towns, counties or regions, separated by commas.</p>

          <fieldset className="ad-images">
            <legend>Photo</legend>
            {images.length === 0 ? (
              <p className="field-hint">
                No photos in your media library yet. Facebook and Instagram ads need one, so add a photo under Media
                first.
              </p>
            ) : (
              <div className="ad-image-grid">
                <label className="ad-image-choice">
                  <input type="radio" name="imageAssetPublicId" value="" checked={image === ""} onChange={() => setImage("")} />
                  <span className="ad-image-none">No photo</span>
                </label>
                {images.map((img) => (
                  <label key={img.publicId} className="ad-image-choice">
                    <input
                      type="radio"
                      name="imageAssetPublicId"
                      value={img.publicId}
                      checked={image === img.publicId}
                      onChange={() => setImage(img.publicId)}
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element -- library thumbnail */}
                    <img src={`/api/media/assets/${img.publicId}/thumb`} alt={img.title ?? "Photo from your library"} />
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </fieldset>
      </div>

      <aside className="ad-editor-side">
        <AdPreview
          businessName={businessName}
          headlines={filled.headlines}
          descriptions={filled.descriptions}
          finalUrl={finalUrl}
          callToAction={cta}
          imageUrl={image ? `/api/media/assets/${image}/preview` : null}
        />

        {problems.length > 0 && (
          <div className="notice notice-warning" role="status">
            <p>
              <strong>Before you can pay:</strong>
            </p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        {claims.length > 0 && (
          <div className="notice notice-info" role="status">
            <p>
              Your business information doesn&rsquo;t mention: <strong>{claims.join(", ")}</strong>. An ad can only
              claim what&rsquo;s true, and we check before it runs. If it is true, tell us and we&rsquo;ll add it to
              your business information.
            </p>
          </div>
        )}

        {state?.message && <p className="error">{state.message}</p>}
        {state?.saved && state.problems.length === 0 && <p className="notice notice-success">Saved.</p>}

        <div className="actions">
          <button type="submit" name="intent" value="continue" disabled={readOnly || pending || problems.length > 0}>
            {pending ? "Saving…" : "Save and choose where it runs"}
          </button>
          <button type="submit" name="intent" value="save" className="secondary" disabled={readOnly || pending}>
            Save draft
          </button>
        </div>
      </aside>
    </form>
  );
}
