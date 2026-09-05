/**
 * A live thumbnail of a client's home page.
 *
 * The admin overview used to show one letter per site, which told the
 * operator nothing they did not already know. This shows the site itself:
 * an iframe of the real home page, rendered at a desktop width and scaled
 * down to the tile, so the grid reads as a wall of the sites you look after
 * — and a site that has broken, gone blank or lost its styles is visible
 * from the overview rather than from a client's phone call.
 *
 * Why a scaled iframe rather than a stored screenshot: it is always current,
 * needs no capture pipeline, no storage and no rasteriser, and the portal
 * runs on a serverless host with no browser to take screenshots with. The
 * cost is one page load per tile, paid by the operator's desktop browser and
 * only when the tile scrolls into view (`loading="lazy"`).
 *
 * Containment: the framed page is on the client's own domain, so it is
 * cross-origin to the portal by construction — it cannot read the portal's
 * cookies or DOM whatever the sandbox says. `sandbox` still removes the
 * things a cross-origin page *can* normally do to its parent: navigate the
 * portal, open windows, submit forms, request pointer lock. `allow-scripts`
 * is required because client sites animate their content in and would
 * otherwise render blank; `allow-same-origin` is required alongside it
 * because without it the frame runs as an opaque origin and any script the
 * site loads with `crossorigin` (every framework's chunks) fails the CORS
 * check and never runs — the same blank tile by a different route. Neither
 * flag makes the page same-origin *with the portal*; that is decided by the
 * URL, and the URL is never the portal's own.
 *
 * `pointer-events: none` keeps clicks on the tile itself; `tabindex="-1"` and
 * `aria-hidden` keep the framed page out of the operator's tab order and
 * screen reader, which are for the portal, not for a miniature of a site.
 *
 * The 4x/0.25 pairing is what makes the scaling width-independent: the
 * frame is laid out at four times the tile's width — 1,200px for a 300px
 * tile, a normal desktop viewport — and shrunk by the same factor, so every
 * tile shows the site as a desktop visitor sees it whatever the grid does.
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

export function SitePreview({
  url,
  name,
  fallbackInitial,
}: {
  url: string | null;
  name: string;
  fallbackInitial: string;
}) {
  if (!url) {
    return <span className="site-preview-initial">{fallbackInitial}</span>;
  }
  return (
    <span className="site-preview" data-url={url}>
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
      {/* The letter stays underneath: if the site refuses to be framed, is
          down, or is slow, the tile still says which client it is. */}
      <span className="site-preview-initial" aria-hidden="true">
        {fallbackInitial}
      </span>
    </span>
  );
}
