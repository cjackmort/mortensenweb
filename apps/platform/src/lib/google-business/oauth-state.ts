import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * The OAuth round trip's memory: what the start route sends the operator to
 * Google with, kept in a cookie so the callback can check that the code
 * coming back is the one this browser, signed in as this operator, asked for.
 *
 * Signed with HMAC-SHA-256 under `AUTH_SECRET`, like the portal's other
 * short-lived tokens (`lib/storage/signed-links.ts`). httpOnly, so page
 * script cannot read the PKCE verifier; ten minutes, which is plenty to click
 * through Google's consent screen.
 */

export const OAUTH_COOKIE = "mw_google_oauth";
export const OAUTH_COOKIE_PATH = "/api/google/oauth";
export const OAUTH_TTL_SECONDS = 10 * 60;

export interface OAuthState {
  state: string;
  codeVerifier: string;
  userId: string;
  expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(payload: string): Promise<Uint8Array> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export async function sealOAuthState(value: OAuthState): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(value)));
  return `${payload}.${base64Url(await hmac(payload))}`;
}

export type OAuthStateCheck = { ok: true; value: OAuthState } | { ok: false; reason: "missing" | "forged" | "expired" | "mismatch" };

/**
 * Check the cookie against what Google sent back and who is signed in.
 * Every refusal is a refusal; the reason is for the log.
 */
export async function verifyOAuthState(
  cookie: string | undefined,
  { state, userId, now = Date.now() }: { state: string | null; userId: string; now?: number },
): Promise<OAuthStateCheck> {
  if (!cookie || !state) return { ok: false, reason: "missing" };
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return { ok: false, reason: "forged" };

  const provided = fromBase64Url(signature);
  if (!provided || !constantTimeEqual(provided, await hmac(payload))) return { ok: false, reason: "forged" };

  let value: OAuthState;
  try {
    value = JSON.parse(new TextDecoder().decode(fromBase64Url(payload) ?? new Uint8Array())) as OAuthState;
  } catch {
    return { ok: false, reason: "forged" };
  }
  if (typeof value.expiresAt !== "number" || value.expiresAt < now) return { ok: false, reason: "expired" };

  const encoder = new TextEncoder();
  if (!constantTimeEqual(encoder.encode(value.state), encoder.encode(state)) || value.userId !== userId) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, value };
}
