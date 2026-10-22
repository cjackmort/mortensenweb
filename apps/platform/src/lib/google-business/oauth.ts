import { GOOGLE_BUSINESS_SCOPE, type GoogleBusinessConfig } from "./config";
import { errorFromResponse, GoogleApiError } from "./errors";

/**
 * The operator's Google sign-in: one OAuth 2.0 web-server flow, done once,
 * that yields the refresh token every sync and every edit runs on.
 *
 * `access_type=offline` and `prompt=consent` together are what make Google
 * return a refresh token on every connect, not only the first; without
 * `prompt=consent` a reconnect gets an access token alone and the portal
 * would have nothing to store.
 *
 * PKCE (S256) on top of the client secret, and a random `state` the callback
 * checks against an httpOnly cookie — so a code arriving at the callback can
 * only be one this browser asked for.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** `openid email` so the connection can say which Google account it is. */
export const REQUESTED_SCOPES = ["openid", "email", GOOGLE_BUSINESS_SCOPE].join(" ");

type FetchLike = typeof fetch;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface AuthorizationStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function startAuthorization(
  config: GoogleBusinessConfig,
  { loginHint }: { loginHint?: string } = {},
): Promise<AuthorizationStart> {
  const state = randomToken();
  const codeVerifier = randomToken(48);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: REQUESTED_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: await challengeFor(codeVerifier),
    code_challenge_method: "S256",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state, codeVerifier };
}

export interface TokenGrant {
  accessToken: string;
  expiresAt: Date;
  refreshToken: string | null;
  scope: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function postToken(body: URLSearchParams, fetchImpl: FetchLike): Promise<TokenGrant> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw await errorFromResponse(response);

  const json = (await response.json()) as TokenResponse;
  if (!json.access_token) {
    throw new GoogleApiError("auth", response.status, "Google returned no access token.");
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    refreshToken: json.refresh_token ?? null,
    scope: json.scope ?? "",
  };
}

export function exchangeCode(
  config: GoogleBusinessConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenGrant> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }),
    fetchImpl,
  );
}

export function refreshAccessToken(
  config: GoogleBusinessConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenGrant> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    fetchImpl,
  );
}

/** Revoke at Google. Best effort: a token Google already forgot is the outcome wanted. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}

export interface GoogleIdentity {
  subject: string;
  email: string;
}

export async function fetchIdentity(accessToken: string, fetchImpl: FetchLike = fetch): Promise<GoogleIdentity> {
  const response = await fetchImpl(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await errorFromResponse(response);
  const json = (await response.json()) as { sub?: string; email?: string };
  if (!json.sub || !json.email) {
    throw new GoogleApiError("auth", response.status, "Google did not say which account this is.");
  }
  return { subject: json.sub, email: json.email };
}

/** Whether the scopes Google granted include the one everything here needs. */
export function grantsBusinessScope(scope: string): boolean {
  return scope.split(/\s+/).includes(GOOGLE_BUSINESS_SCOPE);
}
