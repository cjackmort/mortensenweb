import { CALLS_TO_ACTION, type CallToAction } from "@/lib/ads/creative";

/**
 * Roughly how the ad will look on Google and on Facebook or Instagram.
 *
 * A sketch, not a promise: each platform picks which headlines to show and
 * crops the photo its own way, and the caption says so. It exists so a client
 * reads their words in place before paying for them.
 *
 * No hooks, so the editor can render it live and the checkout page can render
 * it on the server.
 */
export function AdPreview({
  businessName,
  headlines,
  descriptions,
  finalUrl,
  callToAction,
  imageUrl,
}: {
  businessName: string;
  headlines: string[];
  descriptions: string[];
  finalUrl: string | null;
  callToAction: CallToAction | null;
  imageUrl: string | null;
}) {
  let host = "your-website.com";
  try {
    if (finalUrl) host = new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    // An unfinished address still previews, with a placeholder.
  }

  const lines = headlines.filter(Boolean);
  const text = descriptions.filter(Boolean);

  return (
    <div className="ad-preview" aria-label="Preview of your ad">
      <figure className="ad-preview-google">
        <figcaption>On Google</figcaption>
        <div className="ad-preview-card">
          <p className="ad-preview-sponsored">
            Sponsored · <span>{host}</span>
          </p>
          <p className="ad-preview-headline">{lines.slice(0, 3).join(" | ") || "Your headlines"}</p>
          <p className="ad-preview-body">{text.join(" ") || "Your descriptions"}</p>
        </div>
      </figure>

      <figure className="ad-preview-social">
        <figcaption>On Facebook and Instagram</figcaption>
        <div className="ad-preview-card">
          <p className="ad-preview-page">
            <strong>{businessName}</strong>
            <span>Sponsored</span>
          </p>
          <p className="ad-preview-body">{text[0] || "Your first description"}</p>
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed-in library image, already resized
            <img className="ad-preview-image" src={imageUrl} alt="" />
          ) : (
            <div className="ad-preview-image ad-preview-image--empty">No photo chosen</div>
          )}
          <div className="ad-preview-foot">
            <span>
              <small>{host}</small>
              {lines[0] || "Your first headline"}
            </span>
            <span className="ad-preview-cta">{callToAction ? CALLS_TO_ACTION[callToAction] : "Learn more"}</span>
          </div>
        </div>
      </figure>
      <p className="field-hint">
        A sketch. Each platform chooses which of your headlines to show and crops the photo its own way.
      </p>
    </div>
  );
}
