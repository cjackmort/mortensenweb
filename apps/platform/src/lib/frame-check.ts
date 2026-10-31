/**
 * Whether the portal may put a client's home page in an iframe.
 *
 * The "live" grid thumbnail frames the real site, and a browser refuses to
 * render a frame the site has not allowed. The refusal happens in the
 * operator's browser, so the page itself never says why — it draws a tiny
 * "refused to connect" error inside the tile. Fetching the site from the server
 * and reading the same two headers the browser reads turns that into a message
 * at the moment the operator picks "live", while they can still do something
 * about it.
 *
 * Two headers can refuse a frame, and they are not equals:
 *
 *  - `Content-Security-Policy: frame-ancestors …` is an allow-list. It can name
 *    the portal.
 *  - `X-Frame-Options` is not. Only `DENY` and `SAMEORIGIN` exist, and the
 *    portal is never the site's own origin, so both refuse it. (`ALLOW-FROM`
 *    was the escape hatch; no current browser honours it.)
 *
 * Where a site sends both, a browser obeys `frame-ancestors` and ignores
 * `X-Frame-Options` (CSP Level 3, "Relation to X-Frame-Options"). Checking the
 * two independently would turn away a site whose CSP does name the portal
 * merely because a leftover `SAMEORIGIN` is still being sent.
 */

export const PORTAL_ORIGIN = "https://portal.mortensenweb.com";

/** The one line a site needs. Matches `templates/client-repo/netlify.toml`. */
export const FRAME_FIX = `Content-Security-Policy: frame-ancestors 'self' ${PORTAL_ORIGIN}`;

const CHECK_TIMEOUT_MS = 5_000;
const FIRST_SERVER_ERROR = 500;

export type FramingVerdict =
  | { framable: true }
  | {
      framable: false;
      blockedBy: "x-frame-options" | "csp-frame-ancestors";
      /** The header exactly as the site sends it, for the operator to recognise. */
      header: string;
    };

/** A verdict, or "could not tell" — which is not the same as "allowed". */
export type FramingCheck = FramingVerdict | { framable: null; reason: string };

const PORTAL_HOST = new URL(PORTAL_ORIGIN).hostname;

/** Does one `frame-ancestors` source expression admit the portal's origin? */
function sourceAllowsPortal(source: string): boolean {
  const s = source.toLowerCase();
  if (s === "*") return true;
  // 'self' is the framed site's own origin, never the portal's; 'none' and the
  // rest of the quoted keywords admit nobody.
  if (s.startsWith("'")) return false;
  // A scheme source. `http:` matches `https:` too — the spec treats the
  // secure scheme as satisfying the insecure one.
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return s === "https:" || s === "http:";

  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\*|\d+))?(?:\/.*)?$/.exec(s);
  if (!match) return false;
  const [, scheme, host, port] = match;

  if (scheme && scheme !== "https" && scheme !== "http") return false;
  if (port && port !== "*" && port !== "443") return false;

  // `*.example.com` needs at least one label in front, so it does not match the
  // bare parent — and `*.portal.mortensenweb.com` does not match the portal.
  if (host!.startsWith("*.")) return PORTAL_HOST.endsWith(host!.slice(1));
  return host === PORTAL_HOST;
}

/**
 * The `frame-ancestors` directive of one policy, as sent, or null when it has
 * none. The first occurrence wins, as it does in a browser.
 */
function frameAncestorsDirective(policy: string): string | null {
  for (const raw of policy.split(";")) {
    const directive = raw.trim();
    if (directive.split(/\s+/)[0]?.toLowerCase() === "frame-ancestors") return directive;
  }
  return null;
}

function directiveAllowsPortal(directive: string): boolean {
  const sources = directive.split(/\s+/).slice(1);
  // An empty list admits nobody, the same as 'none'.
  const listed = sources.filter((source) => source.toLowerCase() !== "'none'");
  return listed.some(sourceAllowsPortal);
}

export function framingVerdict(headers: Headers): FramingVerdict {
  // Several CSP headers arrive as one comma-joined value, and each policy is
  // enforced on its own: the strictest one decides.
  const policies = (headers.get("content-security-policy") ?? "")
    .split(",")
    .map(frameAncestorsDirective)
    .filter((directive): directive is string => directive !== null);

  if (policies.length > 0) {
    const refusing = policies.find((directive) => !directiveAllowsPortal(directive));
    return refusing
      ? {
          framable: false,
          blockedBy: "csp-frame-ancestors",
          header: `Content-Security-Policy: ${refusing}`,
        }
      : { framable: true };
  }

  for (const raw of (headers.get("x-frame-options") ?? "").split(",")) {
    const value = raw.trim();
    const upper = value.toUpperCase();
    if (upper === "DENY" || upper === "SAMEORIGIN") {
      return { framable: false, blockedBy: "x-frame-options", header: `X-Frame-Options: ${value}` };
    }
  }

  return { framable: true };
}

/**
 * What to tell the operator when a site refuses the portal: which header, on
 * which site, and the single line that fixes it.
 */
export function framingBlockMessage(
  verdict: Extract<FramingVerdict, { framable: false }>,
  url: string,
): { message: string; fix: string } {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw string: a message that names something is better than none.
  }

  const message =
    verdict.blockedBy === "x-frame-options"
      ? `The live thumbnail can't work yet: ${host} sends ${verdict.header}, which stops the portal from showing it. That header has no way to allow one site, so replace it with the header below, then try again.`
      : `The live thumbnail can't work yet: ${host} sends ${verdict.header}, which doesn't allow the portal to show it. Send the header below instead, then try again.`;

  return { message, fix: FRAME_FIX };
}

/**
 * Fetch the page a frame would load and read its framing headers.
 *
 * Answers `framable: null` rather than guessing when the site cannot be read —
 * a site that is down has no headers to judge, and "no headers" would read as
 * "allowed". Redirects are followed because the browser follows them and the
 * final response is the one whose headers apply.
 */
export async function checkSiteFraming(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FramingCheck> {
  const { fetchImpl = fetch, timeoutMs = CHECK_TIMEOUT_MS } = options;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { framable: null, reason: `${url} is not a web address.` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { framable: null, reason: `Only http and https addresses can be checked (${url}).` };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html", "user-agent": "MortensenWebPortal/1.0 (frame check)" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { framable: null, reason: `Could not reach ${url} (${detail}).` };
  }

  // Only the headers matter; don't download the page to read them.
  await response.body?.cancel().catch(() => undefined);

  if (response.status >= FIRST_SERVER_ERROR) {
    return {
      framable: null,
      reason: `${url} answered with HTTP ${response.status}, so its framing headers can't be read.`,
    };
  }

  return framingVerdict(response.headers);
}

export type LiveThumbnailGate = { ok: true } | { ok: false; message: string; fix?: string };

/**
 * Whether a site can be switched to the live (framed) thumbnail, and if not,
 * what to tell the operator.
 *
 * Refuses on "could not tell" as well as on "blocked": a live tile for a site
 * nobody could read is a guess, and a wrong guess is the empty error box this
 * exists to stop. The unreachable message carries no fix line because the
 * header may be perfectly fine.
 */
export async function liveThumbnailGate(
  url: string | null,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LiveThumbnailGate> {
  if (!url) {
    return {
      ok: false,
      message: "This site has no domain yet, so there is nothing to show live. Add its domain first.",
    };
  }

  const check = await checkSiteFraming(url, options);
  if (check.framable === true) return { ok: true };
  if (check.framable === null) {
    return {
      ok: false,
      message: `${check.reason} The live thumbnail needs the site to be up so its framing headers can be checked — try again in a moment.`,
    };
  }
  return { ok: false, ...framingBlockMessage(check, url) };
}
