/**
 * A thumbnail of a client's home page.
 *
 * The admin overview used to show one letter per site, which told the
 * operator nothing they did not already know. This shows the site itself, so
 * the grid reads as a wall of the sites you look after — and a site that has
 * broken, gone blank or lost its styles is visible from the overview rather
 * than from a client's phone call.
 *
 * There are two ways to draw that, and which one a site gets is stored on the
 * site (`sites.preview_mode`), because the right answer differs per site.
 *
 * `screenshot` — the default, and what almost every site should use. The
 * deploy takes a 1280x720 picture of the home page and publishes it with the
 * site at `/__preview/home-tile.png` (see agent/verify/screenshot.mjs and
 * .github/workflows/client-deploy.yml). The portal loads it as an ordinary
 * image.
 *
 * Why this is the default, having started the other way round: a cross-origin
 * iframe is refused by any site that sends `X-Frame-Options` or a CSP
 * `frame-ancestors` — which is most of them, correctly, since that is the
 * defence against clickjacking. The portal cannot opt out of another site's
 * refusal, so the live-frame tile was blank for three of the first four
 * clients while all three sites were perfectly healthy. A picture cannot be
 * blocked, costs one small image instead of a whole page load, and is exactly
 * as current as the last deploy — which for a static site is the only moment
 * it could have changed.
 *
 * `live` — an iframe of the real home page, for sites a still picture
 * misrepresents: an animated background, a canvas, anything that moves.
 * It only works where that site's own headers name the portal in
 * `frame-ancestors`, so it is opt-in per site and the agent that builds an
 * animated site is told to ship the header with it (agent/skills/animation).
 *
 * Containment, for the `live` path: the framed page is on the client's own
 * domain, so it is cross-origin to the portal by construction — it cannot
 * read the portal's cookies or DOM whatever the sandbox says. `sandbox`
 * still removes the things a cross-origin page *can* normally do to its
 * parent: navigate the portal, open windows, submit forms, request pointer
 * lock. `allow-scripts` is required because an animated site is the only
 * reason to be on this path at all; `allow-same-origin` is required alongside
 * it because without it the frame runs as an opaque origin and any script the
 * site loads with `crossorigin` (every framework's chunks) fails the CORS
 * check and never runs — a blank tile by a different route. Neither flag
 * makes the page same-origin *with the portal*; that is decided by the URL,
 * and the URL is never the portal's own.
 *
 * `pointer-events: none` keeps clicks on the tile itself; `tabindex="-1"` and
 * `aria-hidden` keep the framed page out of the operator's tab order and
 * screen reader, which are for the portal, not for a miniature of a site.
 *
 * The 4x/0.25 pairing is what makes the scaling width-independent: the frame
 * is laid out at four times the tile's width — 1,200px for a 300px tile, a
 * normal desktop viewport — and shrunk by the same factor, so every tile
 * shows the site as a desktop visitor sees it whatever the grid does.
 *
 * The fallback, either way, is the client's initial, and it is drawn *behind*
 * the picture rather than instead of it. Both paths fail by showing nothing —
 * a 404 on a site that has not deployed since this was built, a refused
 * frame — and neither failure is detectable from the server. Layering means
 * the letter is simply what remains visible, with no error handling and no
 * client-side JavaScript. This is a real bug fixed, not a precaution: the
 * frame used to sit on an opaque white background above the letter, so a
 * refused site showed a blank rectangle and the fallback never once appeared.
 */
export function siteHomeUrl(site: {
  primaryDomain?: string | null;
  productionUrl?: string | null;
  netlifySiteName?: string | null;
  status?: string | null;
}): string | null {
  if (site.primaryDomain) return `https://${site.primaryDomain}`;
  if (site.productionUrl) return site.productionUrl;
  if (site.netlifySiteName) return `https://${site.netlifySiteName}.netlify.app`;
  return null;
}

/** Where the deploy publishes the tile shot, relative to the site's own root. */
export const TILE_PATH = "/__preview/home-tile.png";

/**
 * Escape a URL for interpolation into a quoted CSS `url("…")`.
 *
 * React does not sanitise style values, and this URL is built from columns an
 * operator typed (`primary_domain`, `production_url`). A stray quote would
 * otherwise close the string and let the rest be read as CSS.
 */
function cssUrl(raw: string): string {
  return raw.replace(/[\r\n]/g, "").replace(/["'\\]/g, "\\$&");
}

export function SitePreview({
  url,
  name,
  fallbackInitial,
  mode = "screenshot",
}: {
  url: string | null;
  name: string;
  fallbackInitial: string;
  mode?: "screenshot" | "live";
}) {
  if (!url) {
    return <span className="site-preview-initial">{fallbackInitial}</span>;
  }

  return (
    <span className="site-preview" data-url={url}>
      {mode === "live" ? (
        <iframe
          className="site-preview-frame"
          src={url}
          title={`${name} home page`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : (
        /*
         * A background image rather than an <img>, for exactly one reason:
         * how each one fails. A missing background renders as nothing and the
         * letter behind it shows through cleanly. An <img> whose source 404s
         * still occupies its box and Chrome draws a broken-image marker in
         * the corner — verified in a browser, and it is the same "something
         * is wrong with this tile" look the whole change exists to remove.
         *
         * A site that has not deployed since this shipped has no tile shot
         * yet, so the 404 is the ordinary case, not the exceptional one.
         *
         * The trade is lazy loading, which has no `background-image` form.
         * A handful of tiles at a few tens of KB each is not worth an onError
         * handler and turning every tile into a client component.
         */
        <span
          className="site-preview-shot"
          style={{ backgroundImage: `url("${cssUrl(`${url.replace(/\/$/, "")}${TILE_PATH}`)}")` }}
        />
      )}
      {/* Underneath, always: whatever is above either covers it or failed. */}
      <span className="site-preview-initial" aria-hidden="true">
        {fallbackInitial}
      </span>
    </span>
  );
}
