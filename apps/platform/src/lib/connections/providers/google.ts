import type { GoogleBusinessConfig } from "@/lib/google-business/config";
import { GoogleApiError } from "@/lib/google-business/errors";
import { exchangeCode, fetchIdentity, refreshAccessToken, revokeToken } from "@/lib/google-business/oauth";
import { connectionTokenKey } from "../seal";
import {
  percent,
  ProviderError,
  type AuditOutcome,
  type Finding,
  type ProviderGrant,
  type ProviderTokens,
  type TokenUpdate,
} from "../types";

/**
 * Google, for Search Console: what people searched to find the site, how
 * often it was shown, how often it was clicked, and where it ranked.
 *
 * The same Google OAuth client as the agency's profile connection, with a
 * different callback and a read-only scope. Gmail is deliberately not asked
 * for: reading a mailbox is a restricted scope that needs a security
 * assessment to ship, and an inbox tells us less about the business than
 * its search results do. The refresh token is sealed; an access token is
 * minted for each audit and not kept.
 */

export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GOOGLE_CALLBACK_PATH = "/api/connections/google/callback";
const REQUESTED_SCOPES = ["openid", "email", SEARCH_CONSOLE_SCOPE].join(" ");
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/webmasters/v3";
/** Search Console reports lag by about two days; the window ends there. */
const DATA_LAG_DAYS = 2;
const WINDOW_DAYS = 28;

type FetchLike = typeof fetch;

export type GoogleSearchConfig =
  | { ok: true; config: GoogleBusinessConfig }
  | { ok: false; missing: string[] };

export function googleSearchConfig(env: Record<string, string | undefined> = process.env): GoogleSearchConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const base = env.AUTH_URL?.trim();
  const redirectUri = base ? `${base.replace(/\/$/, "")}${GOOGLE_CALLBACK_PATH}` : "";
  const tokenKey = connectionTokenKey(env) ?? "";
  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !clientSecret && "GOOGLE_CLIENT_SECRET",
    !redirectUri && "AUTH_URL",
    !tokenKey && "CONNECTION_TOKEN_KEY",
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { clientId, clientSecret, redirectUri, tokenKey } };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function googleAuthorization(
  config: GoogleBusinessConfig,
  state: string,
): Promise<{ url: string; codeVerifier: string }> {
  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))),
  );
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: REQUESTED_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, codeVerifier };
}

export async function exchangeGoogleCode(
  config: GoogleBusinessConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderGrant> {
  let grant;
  try {
    grant = await exchangeCode(config, code, codeVerifier, fetchImpl);
  } catch (error) {
    throw new ProviderError("auth", error instanceof Error ? error.message : "Google refused the code.");
  }
  if (!grant.scope.split(/\s+/).includes(SEARCH_CONSOLE_SCOPE)) {
    throw new ProviderError("auth", "Search Console access was not granted.");
  }
  if (!grant.refreshToken) throw new ProviderError("auth", "Google issued no refresh token.");
  const identity = await fetchIdentity(grant.accessToken, fetchImpl);
  return {
    externalId: identity.subject,
    displayName: identity.email,
    scope: grant.scope,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
  };
}

export async function revokeGoogle(tokens: ProviderTokens, fetchImpl: FetchLike = fetch): Promise<void> {
  const token = tokens.refreshToken ?? tokens.accessToken;
  if (token) await revokeToken(token, fetchImpl);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SearchRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchSnapshot {
  /** The Search Console property that matched the site, or null for none. */
  property: string | null;
  /** Every property the Google account can see, so a mismatch can be explained. */
  properties: string[];
  startDate: string;
  endDate: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  previous: { clicks: number; impressions: number };
  queries: SearchRow[];
  pages: SearchRow[];
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

async function googleGet<T>(url: string, accessToken: string, fetchImpl: FetchLike, body?: unknown): Promise<T> {
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const kind = response.status === 401 || response.status === 403 ? "auth" : "unavailable";
    throw new ProviderError(kind, `Google ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/** The property whose host is the site's, preferring a domain property. */
export function matchProperty(properties: string[], siteHost: string | null): string | null {
  if (!siteHost) return null;
  const wanted = siteHost.replace(/^www\./, "").toLowerCase();
  const domain = properties.find((p) => p === `sc-domain:${wanted}`);
  if (domain) return domain;
  return (
    properties.find((p) => {
      const m = p.match(/^https?:\/\/(?:www\.)?([^/]+)\/?$/i);
      return m?.[1]?.toLowerCase() === wanted;
    }) ?? null
  );
}

async function usableAccessToken(
  tokens: ProviderTokens,
  config: GoogleBusinessConfig,
  now: Date,
  fetchImpl: FetchLike,
): Promise<{ accessToken: string; update?: TokenUpdate }> {
  const fresh = tokens.accessToken && tokens.expiresAt && tokens.expiresAt.getTime() > now.getTime() + 60_000;
  if (fresh) return { accessToken: tokens.accessToken! };
  if (!tokens.refreshToken) throw new ProviderError("auth", "No refresh token; reconnect Google.");
  try {
    const grant = await refreshAccessToken(config, tokens.refreshToken, fetchImpl);
    return {
      accessToken: grant.accessToken,
      update: { accessToken: grant.accessToken, expiresAt: grant.expiresAt },
    };
  } catch (error) {
    const kind = error instanceof GoogleApiError && error.kind === "auth" ? "auth" : "unavailable";
    throw new ProviderError(kind, error instanceof Error ? error.message : "Google token refresh failed.");
  }
}

export async function fetchSearchSnapshot(
  tokens: ProviderTokens,
  config: GoogleBusinessConfig,
  context: { siteHost: string | null; now: Date; fetchImpl?: FetchLike },
): Promise<{ snapshot: SearchSnapshot; update?: TokenUpdate }> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const { accessToken, update } = await usableAccessToken(tokens, config, context.now, fetchImpl);

  const listed = await googleGet<{ siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }>(
    `${API}/sites`,
    accessToken,
    fetchImpl,
  );
  const properties = (listed.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => s.siteUrl);
  const property = matchProperty(properties, context.siteHost);

  const end = daysAgo(context.now, DATA_LAG_DAYS);
  const start = daysAgo(end, WINDOW_DAYS - 1);
  const previousEnd = daysAgo(start, 1);
  const previousStart = daysAgo(previousEnd, WINDOW_DAYS - 1);
  const empty = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  if (!property) {
    return {
      snapshot: {
        property: null,
        properties,
        startDate: dateOnly(start),
        endDate: dateOnly(end),
        totals: empty,
        previous: { clicks: 0, impressions: 0 },
        queries: [],
        pages: [],
      },
      update,
    };
  }

  const url = `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  type Rows = { rows?: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }> };
  const query = (body: Record<string, unknown>) => googleGet<Rows>(url, accessToken, fetchImpl, body);
  const [current, previous, byQuery, byPage] = await Promise.all([
    query({ startDate: dateOnly(start), endDate: dateOnly(end) }),
    query({ startDate: dateOnly(previousStart), endDate: dateOnly(previousEnd) }),
    query({ startDate: dateOnly(start), endDate: dateOnly(end), dimensions: ["query"], rowLimit: 25 }),
    query({ startDate: dateOnly(start), endDate: dateOnly(end), dimensions: ["page"], rowLimit: 25 }),
  ]);
  const toRows = (r: Rows): SearchRow[] =>
    (r.rows ?? []).map((row) => ({
      key: row.keys?.[0] ?? "",
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));
  const totals = current.rows?.[0] ?? empty;
  const prior = previous.rows?.[0] ?? empty;

  return {
    snapshot: {
      property,
      properties,
      startDate: dateOnly(start),
      endDate: dateOnly(end),
      totals: { clicks: totals.clicks, impressions: totals.impressions, ctr: totals.ctr, position: totals.position },
      previous: { clicks: prior.clicks, impressions: prior.impressions },
      queries: toRows(byQuery),
      pages: toRows(byPage),
    },
    update,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** A query shown this often and ranking just off page one is the cheapest win there is. */
const NEAR_PAGE_ONE_MIN_IMPRESSIONS = 50;
const NEAR_PAGE_ONE_POSITION = { from: 4, to: 15 };
/** A page shown this often with this few clicks has a title or description problem. */
const LOW_CTR_MIN_IMPRESSIONS = 100;
const LOW_CTR_MAX = 0.015;
const DROP_CONCERN_PERCENT = 20;

export function auditSearch(
  snapshot: SearchSnapshot,
  context: { siteHost: string | null; now: Date; startAt: Date; endAt: Date },
): AuditOutcome["audit"] {
  const findings: Finding[] = [];
  const t = snapshot.totals;

  if (!snapshot.property) {
    findings.push({
      severity: "fix",
      title: context.siteHost ? `${context.siteHost} is not in this Google account's Search Console` : "No website to match in Search Console",
      detail:
        snapshot.properties.length > 0
          ? `This Google account sees ${snapshot.properties.length} propert${snapshot.properties.length === 1 ? "y" : "ies"}, none of them your site. Add the site at search.google.com/search-console (we can verify it for you), or connect the Google account that owns it.`
          : "This Google account has no Search Console properties. Add your site at search.google.com/search-console — we can put the verification record on the site for you.",
    });
  } else {
    if (t.impressions === 0) {
      findings.push({
        severity: "fix",
        title: "Google showed the site to nobody",
        detail: "No impressions in four weeks usually means the site is not indexed. Check the Pages report in Search Console for errors, and ask us to request indexing.",
      });
    }

    const near = snapshot.queries
      .filter(
        (q) =>
          q.impressions >= NEAR_PAGE_ONE_MIN_IMPRESSIONS &&
          q.position >= NEAR_PAGE_ONE_POSITION.from &&
          q.position <= NEAR_PAGE_ONE_POSITION.to,
      )
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 3);
    if (near.length > 0) {
      findings.push({
        severity: "improve",
        title: `Close to the top of Google for “${near[0]!.key}”`,
        detail: `${near.map((q) => `“${q.key}” (position ${q.position.toFixed(0)}, ${q.impressions} shown)`).join(", ")}. A page written for ${near.length === 1 ? "that search" : "those searches"} — or a stronger section on the one that ranks — is the quickest way up.`,
      });
    }

    const lowCtr = snapshot.pages
      .filter((p) => p.impressions >= LOW_CTR_MIN_IMPRESSIONS && p.ctr < LOW_CTR_MAX)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 2);
    if (lowCtr.length > 0) {
      findings.push({
        severity: "improve",
        title: "Pages that are seen but not clicked",
        detail: `${lowCtr.map((p) => `${p.key.replace(/^https?:\/\/[^/]+/, "") || "/"} (${p.impressions} shown, ${(p.ctr * 100).toFixed(1)}% clicked)`).join("; ")}. The title and description are what people see in the results; ask us to rewrite them to say what the page offers and where.`,
      });
    }

    const change = snapshot.previous.clicks > 0 ? percent(t.clicks - snapshot.previous.clicks, snapshot.previous.clicks) : null;
    if (change !== null && change <= -DROP_CONCERN_PERCENT) {
      findings.push({
        severity: "improve",
        title: `Clicks from Google down ${Math.round(-change)}%`,
        detail: `${t.clicks} clicks against ${snapshot.previous.clicks} in the four weeks before. Seasonal dips happen; a drop that lasts usually follows a change on the site or a competitor's new page. Worth a look at which queries fell.`,
      });
    } else if (change !== null && change >= DROP_CONCERN_PERCENT) {
      findings.push({
        severity: "good",
        title: `Clicks from Google up ${Math.round(change)}%`,
        detail: `${t.clicks} clicks against ${snapshot.previous.clicks} in the four weeks before.`,
      });
    }

    if (findings.length === 0) {
      findings.push({
        severity: "good",
        title: "Search is steady",
        detail: `${t.clicks} clicks from ${t.impressions} times shown, average position ${t.position.toFixed(1)}.`,
      });
    }
  }

  return {
    version: 1,
    at: context.now.toISOString(),
    startAt: context.startAt.toISOString(),
    endAt: context.endAt.toISOString(),
    headline: snapshot.property
      ? `${t.clicks} click${t.clicks === 1 ? "" : "s"} from Google, shown ${t.impressions} times`
      : "Site not found in Search Console",
    rows: snapshot.property
      ? [
          { label: "Clicks", value: String(t.clicks) },
          { label: "Shown in results", value: String(t.impressions) },
          { label: "Click rate", value: `${(t.ctr * 100).toFixed(1)}%` },
          { label: "Average position", value: t.position > 0 ? t.position.toFixed(1) : "–" },
          ...(snapshot.queries[0] ? [{ label: "Top search", value: snapshot.queries[0].key }] : []),
        ]
      : [],
    findings,
    snapshot: { ...snapshot },
  };
}
