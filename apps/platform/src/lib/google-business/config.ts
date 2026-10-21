/**
 * What the Google integration needs from the environment, and what is missing.
 *
 * Four values, all the operator's: the OAuth client from their Google Cloud
 * project, the redirect URI registered on it, and the key that seals the
 * refresh token at rest. None has a default that would let a half-configured
 * deployment look connected — the pages show "Not connected" and list what is
 * missing instead, by name, so the operator knows which variable to set.
 */

export const GOOGLE_BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** The callback route, relative to the portal's own origin. */
export const CALLBACK_PATH = "/api/google/oauth/callback";

export interface GoogleBusinessConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Base64 of 32 random bytes. */
  tokenKey: string;
}

export type ConfigCheck =
  | { ok: true; config: GoogleBusinessConfig }
  | { ok: false; missing: string[]; redirectUri: string | null };

/** The redirect URI this deployment would register, set explicitly or derived from AUTH_URL. */
export function expectedRedirectUri(): string | null {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = process.env.AUTH_URL?.trim();
  return base ? `${base.replace(/\/$/, "")}${CALLBACK_PATH}` : null;
}

export function googleBusinessConfig(): ConfigCheck {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const tokenKey = process.env.GOOGLE_TOKEN_KEY?.trim() ?? "";
  const redirectUri = expectedRedirectUri();

  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !clientSecret && "GOOGLE_CLIENT_SECRET",
    !redirectUri && "GOOGLE_REDIRECT_URI",
    !tokenKey && "GOOGLE_TOKEN_KEY",
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0 || !redirectUri) return { ok: false, missing, redirectUri };
  return { ok: true, config: { clientId, clientSecret, redirectUri, tokenKey } };
}

/** Cheap check for callers that only need to know whether to try. */
export function googleBusinessConfigured(): boolean {
  return googleBusinessConfig().ok;
}
