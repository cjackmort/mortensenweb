import { sha256Hex } from "./password";
import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * The operator API's bearer token.
 *
 * The portal holds only the token's SHA-256, in `OPERATOR_API_TOKEN_SHA256`.
 * The token itself lives in one place, the agency folder's gitignored
 * `.env.local`, so neither Netlify's environment, a build log nor a leaked
 * copy of the portal's variables is enough to call the API.
 *
 * A plain hash rather than a password KDF is deliberate: the token is 256
 * random bits, not something a person chose, so there is no dictionary to slow
 * down — and a fast hash keeps a flood of bad tokens cheap to refuse.
 */

export type TokenCheck = "ok" | "missing" | "invalid" | "not_configured";

const HEX_SHA256 = /^[0-9a-f]{64}$/;
/** Anything shorter was not made by the generator and is refused unhashed. */
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;

/** The configured hash, or null when it is absent or not a SHA-256 in hex. */
function expectedHash(): string | null {
  const raw = process.env.OPERATOR_API_TOKEN_SHA256?.trim().toLowerCase();
  if (!raw) return null;
  if (!HEX_SHA256.test(raw)) {
    // A mistyped variable must refuse, not compare against garbage that a
    // second mistake could match.
    console.error("[operator-api] OPERATOR_API_TOKEN_SHA256 is not a 64-character hex SHA-256");
    return null;
  }
  return raw;
}

export function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/**
 * Compare a request's bearer token with the configured hash, in constant time.
 *
 * Unset means every request is refused: an API nobody configured should look
 * broken, because it is.
 */
export async function checkOperatorToken(headers: Headers): Promise<TokenCheck> {
  const expected = expectedHash();
  if (!expected) return "not_configured";

  const token = bearerToken(headers);
  if (!token) return "missing";
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return "invalid";

  const encoder = new TextEncoder();
  const matches = constantTimeEqual(
    encoder.encode(await sha256Hex(token)),
    encoder.encode(expected),
  );
  return matches ? "ok" : "invalid";
}
