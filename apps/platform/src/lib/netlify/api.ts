/**
 * Netlify, as much of it as the pipeline needs.
 *
 * The shape of this integration is set by one decision recorded in
 * `docs/stage-3-automation-plan.md` (D2): **the portal creates sites, but does
 * not link them to GitHub.** Linking a repository through Netlify's API needs
 * the per-account `installation_id` of their GitHub App, which is only issued
 * through their browser OAuth flow and cannot be obtained from a server. Every
 * published recipe for doing it anyway is a scrape of that flow.
 *
 * So the client repository deploys itself, from its own workflow, with a site
 * id the portal hands it. That inverts the usual arrangement and is better
 * here: build behaviour lives in one file the agent can read and we can review,
 * rather than half in a workflow and half in a hosting dashboard.
 *
 * What this module is for, then, is the three things the portal genuinely needs
 * from Netlify: make a site, find out what it deployed, and check that a URL a
 * client is about to be sent to actually resolves.
 */

const API_BASE = "https://api.netlify.com/api/v1";

export class NetlifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetlifyConfigError";
  }
}

export class NetlifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NetlifyApiError";
  }
}

/**
 * Whether Netlify is usable at all in this environment.
 *
 * Same contract as `isGithubConfigured` and `isUmamiConfigured`: a feature
 * missing its credentials reports itself, so the admin UI can say what is
 * missing rather than surfacing a stack trace from four layers down.
 */
export function isNetlifyConfigured(): boolean {
  return Boolean(process.env.NETLIFY_AUTH_TOKEN);
}

async function netlifyRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    allowStatuses?: number[];
  } = {},
): Promise<{ status: number; data: T }> {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new NetlifyConfigError("NETLIFY_AUTH_TOKEN is not set.");

  const { method = "GET", body, allowStatuses = [] } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "mortensenweb-portal",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Never cache: every call here is either a mutation or a liveness question,
    // and a cached "yes it is deployed" is exactly the wrong answer to hold on
    // to for five minutes.
    cache: "no-store",
  });

  if (!response.ok && !allowStatuses.includes(response.status)) {
    let message = `Netlify request failed (HTTP ${response.status}).`;
    try {
      const problem = (await response.json()) as { message?: string };
      if (problem.message) message = `${message} ${problem.message}`;
    } catch {
      // Non-JSON error bodies are not worth failing over.
    }
    throw new NetlifyApiError(message, response.status);
  }

  const data =
    response.status === 204
      ? (undefined as T)
      : ((await response.json().catch(() => undefined)) as T);

  return { status: response.status, data };
}

// ---------------------------------------------------------------------------
// Site names
// ---------------------------------------------------------------------------

/**
 * Netlify site names live in one global namespace and become hostnames, so the
 * rules are DNS label rules: lowercase alphanumerics and hyphens, no leading or
 * trailing hyphen, 63 characters at the outside.
 *
 * The suffix is not decoration. Two clients called "Rocky Mountain Heating"
 * would collide, and — worse — the *first* one to be created would silently own
 * the good name while the second failed at scaffold time, in front of a
 * prospect. Making every name unique by construction removes that entirely.
 */
export function toSiteName(businessName: string, suffix: string): string {
  const slug = businessName
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "Peña" becomes "pena" rather than "pea".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const cleanSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const room = 63 - cleanSuffix.length - 1;
  const base = (slug || "site").slice(0, Math.max(1, room)).replace(/-+$/, "");

  return `${base}-${cleanSuffix}`;
}

/**
 * The deploy-preview URL for a pull request.
 *
 * Netlify's alias URLs are `https://<alias>--<site-name>.netlify.app`, and the
 * client repository's workflow deploys every pull request under the alias `pr-<n>`.
 * Because both halves are known, the URL can be constructed without an API call
 * — but a constructed URL is a *prediction*, not an observation. It is a valid
 * string from the moment the pull request opens, well before any build has
 * produced anything at it.
 *
 * Nothing may show this to a client until `verifyUrlServes` has agreed.
 */
export function previewUrlFor(siteName: string, prNumber: number): string {
  return `https://pr-${prNumber}--${siteName}.netlify.app`;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export interface NetlifySite {
  id: string;
  name: string;
  url: string;
  ssl_url: string;
  admin_url: string;
}

/**
 * Create an unlinked site.
 *
 * `account_slug` selects which Netlify team owns it. On a personal account
 * there is exactly one and it can be omitted; on a team account omitting it
 * lands the site somewhere arbitrary, so it is configuration rather than a
 * guess.
 */
export async function createSite(input: {
  name: string;
  accountSlug?: string;
}): Promise<NetlifySite> {
  const accountSlug = input.accountSlug ?? process.env.NETLIFY_ACCOUNT_SLUG;
  const path = accountSlug
    ? `/${encodeURIComponent(accountSlug)}/sites`
    : "/sites";

  const { data } = await netlifyRequest<NetlifySite>(path, {
    method: "POST",
    body: {
      name: input.name,
      // Deploy previews are the whole mechanism behind client approval, so they
      // are switched on explicitly rather than left to the account default.
      processing_settings: { skip: false },
    },
  });

  return data;
}

export async function getSite(siteId: string): Promise<NetlifySite | null> {
  const { status, data } = await netlifyRequest<NetlifySite>(
    `/sites/${encodeURIComponent(siteId)}`,
    { allowStatuses: [404] },
  );
  return status === 404 ? null : data;
}

// ---------------------------------------------------------------------------
// Deploys
// ---------------------------------------------------------------------------

export interface NetlifyDeploy {
  id: string;
  state: string;
  /** Present on alias/branch deploys; this is the URL a client would open. */
  deploy_ssl_url?: string;
  ssl_url?: string;
  commit_ref?: string;
  branch?: string;
  error_message?: string;
  created_at?: string;
}

export async function listDeploys(
  siteId: string,
  { perPage = 20 }: { perPage?: number } = {},
): Promise<NetlifyDeploy[]> {
  const { data } = await netlifyRequest<NetlifyDeploy[]>(
    `/sites/${encodeURIComponent(siteId)}/deploys?per_page=${perPage}`,
  );
  return data ?? [];
}

/**
 * The most recent deploy of one commit.
 *
 * Matching on the commit SHA rather than the branch is what makes this safe to
 * use for approval: the client approves a specific set of changes, and the
 * merge is pinned to the same SHA. Matching on branch would happily return a
 * deploy of a *later* push that the client never saw.
 */
export async function findDeployForCommit(
  siteId: string,
  commitSha: string,
): Promise<NetlifyDeploy | null> {
  const deploys = await listDeploys(siteId, { perPage: 50 });
  return deploys.find((d) => d.commit_ref === commitSha) ?? null;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

export type UrlCheck =
  | { ok: true; status: number }
  | { ok: false; reason: "not_found" | "server_error" | "unreachable"; status?: number };

/**
 * Does this URL actually serve a page right now?
 *
 * Used before showing a client a preview link and before declaring a site live.
 * Both are moments where being wrong is expensive in a way that is hard to
 * undo — sending someone to a 404 and asking them to approve it costs their
 * confidence, not just a retry.
 *
 * A `GET` rather than a `HEAD`: some CDNs, Netlify's included, treat HEAD
 * differently enough that a HEAD-only check can pass against a page that does
 * not render. The response body is discarded.
 *
 * No redirects are followed. A preview URL that redirects somewhere else is not
 * the preview, and following the redirect would report success for the wrong
 * page entirely.
 */
export async function verifyUrlServes(
  url: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<UrlCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "mortensenweb-portal (preview verification)" },
      cache: "no-store",
    });

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    if (response.status === 404) return { ok: false, reason: "not_found", status: 404 };
    return { ok: false, reason: "server_error", status: response.status };
  } catch {
    // DNS failure, TLS failure, timeout. From the caller's point of view these
    // are the same fact: the client cannot open this link.
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
