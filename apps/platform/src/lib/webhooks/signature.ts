/**
 * Webhook signature verification.
 *
 * Two providers, one shape of problem: a sender computes HMAC-SHA-256 over some
 * canonical string with a shared secret, and we recompute it and compare. The
 * details differ — what goes into the string, and how the digest is encoded —
 * and both differences are places where a plausible-looking implementation
 * verifies nothing at all.
 *
 * Three rules apply to every function here.
 *
 * **The raw body, before any parsing.** `JSON.parse` followed by
 * `JSON.stringify` does not round-trip: key order, unicode escapes, and number
 * formatting can all change. Signing the re-serialised body compares our
 * rendering against their bytes, which fails for legitimate requests and — far
 * worse — invites someone to "fix" it by loosening the check.
 *
 * **Constant-time comparison.** `a === b` on strings returns at the first
 * differing byte. That timing is measurable across a network with enough
 * samples, and it turns forging a signature into a byte-at-a-time search
 * instead of a 2^256 one.
 *
 * **Failure is silent to the caller.** A verification failure returns `false`.
 * It never explains *why*, and nothing here is logged with the expected digest
 * in it, because an error message that distinguishes "wrong length" from "wrong
 * bytes" is an oracle.
 */

/**
 * Length-independent, content-constant-time comparison over bytes.
 *
 * Length is compared first and non-secretly. For a fixed-size digest, a length
 * mismatch means the input was malformed rather than close, so it leaks
 * nothing an attacker could not determine by reading the spec.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(signature);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * Verify `X-Hub-Signature-256`.
 *
 * GitHub signs the raw request body with the webhook secret and sends the
 * digest hex-encoded, prefixed `sha256=`. The prefix is checked rather than
 * stripped blindly: a `sha1=` header is a *different, broken* algorithm, and
 * accepting one by ignoring the prefix would silently downgrade the check.
 */
export async function verifyGithubSignature(
  rawBody: string,
  headerValue: string | null,
  secret: string,
): Promise<boolean> {
  if (!headerValue || !secret) return false;
  if (!headerValue.startsWith("sha256=")) return false;

  const provided = hexToBytes(headerValue.slice("sha256=".length));
  if (!provided) return false;

  const expected = await hmacSha256(secret, rawBody);
  return constantTimeEqual(provided, expected);
}

/** Exposed for tests: produce the header a valid GitHub delivery would carry. */
export async function githubSignatureFor(
  rawBody: string,
  secret: string,
): Promise<string> {
  return `sha256=${toHex(await hmacSha256(secret, rawBody))}`;
}

// ---------------------------------------------------------------------------
// Square
// ---------------------------------------------------------------------------

/**
 * Verify `x-square-hmacsha256-signature`.
 *
 * Square's signed string is **the notification URL concatenated with the raw
 * body**, and the digest is base64 rather than hex. Including the URL is what
 * stops a signature captured from one endpoint being replayed against another,
 * so the URL passed here must be the exact string configured in Square's
 * dashboard — scheme, host, path, no trailing slash unless it is configured
 * with one. A mismatch here fails every delivery, which is the correct failure:
 * the alternative, deriving the URL from the incoming request, would let a
 * `Host` header decide what we verify against.
 */
export async function verifySquareSignature(
  rawBody: string,
  headerValue: string | null,
  signatureKey: string,
  notificationUrl: string,
): Promise<boolean> {
  if (!headerValue || !signatureKey || !notificationUrl) return false;

  const provided = base64ToBytes(headerValue);
  if (!provided) return false;

  const expected = await hmacSha256(signatureKey, `${notificationUrl}${rawBody}`);
  return constantTimeEqual(provided, expected);
}

/** Exposed for tests: produce the header a valid Square delivery would carry. */
export async function squareSignatureFor(
  rawBody: string,
  signatureKey: string,
  notificationUrl: string,
): Promise<string> {
  return bytesToBase64(
    await hmacSha256(signatureKey, `${notificationUrl}${rawBody}`),
  );
}
