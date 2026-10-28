import { openSecret, sealSecret } from "@/lib/google-business/seal";

/**
 * Tokens for connected accounts are sealed the way the agency's Google
 * refresh token is, with `CONNECTION_TOKEN_KEY` — or, unset, the same
 * `GOOGLE_TOKEN_KEY`, so one key set up for Google profiles covers these
 * too. A missing key means no account can be connected, not a token stored
 * in the clear.
 */

export function connectionTokenKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.CONNECTION_TOKEN_KEY?.trim() || env.GOOGLE_TOKEN_KEY?.trim();
  return key || null;
}

export async function sealToken(plaintext: string): Promise<string> {
  const key = connectionTokenKey();
  if (!key) throw new Error("CONNECTION_TOKEN_KEY (or GOOGLE_TOKEN_KEY) is not set.");
  return sealSecret(plaintext, key);
}

export async function openToken(sealed: string): Promise<string> {
  const key = connectionTokenKey();
  if (!key) throw new Error("CONNECTION_TOKEN_KEY (or GOOGLE_TOKEN_KEY) is not set.");
  return openSecret(sealed, key);
}
