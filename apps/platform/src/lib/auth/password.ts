/**
 * Password hashing.
 *
 * PBKDF2-HMAC-SHA-256 via Web Crypto, 600,000 iterations (the OWASP figure for
 * this KDF), 16-byte random salt, 32-byte derived key.
 *
 * Why PBKDF2 rather than Argon2id or bcrypt: the production runtime is
 * Cloudflare Workers, which offers no native Argon2 or bcrypt. Web Crypto's
 * PBKDF2 is the only KDF implemented in native code there; a WASM Argon2 would
 * be both slower and larger. The stored format records the algorithm and its
 * parameters, so migrating to Argon2id later is a rehash-on-login, not a flag
 * day.
 *
 * NOTE: 600,000 iterations costs far more than the 10 ms CPU allowed per
 * invocation on the Workers *free* plan. This requires Workers Paid. Lowering
 * the iteration count to fit a free-tier limit is not an acceptable
 * alternative and must not be done.
 *
 * Stored as a PHC-style string:
 *   $pbkdf2-sha256$i=600000$<salt-b64>$<hash-b64>
 */

export const PASSWORD_ALGO = "pbkdf2-sha256";
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/**
 * Minimum length. Length beats composition rules; no character-class theatre.
 *
 * This is the single source of truth for the floor. `hashPassword` enforces it
 * as a hard backstop and throws below it, so any policy check elsewhere must
 * use this same constant — `@/lib/auth/session` re-exports it rather than
 * declaring its own. A second, lower constant would let a password pass
 * validation and then throw at the hashing step, which is a 500, not a
 * validation error.
 *
 * Set to 5 by explicit product decision, against the usual advice. Be clear
 * about what that trades away: online guessing is still covered — five failures
 * lock the account for fifteen minutes and the login endpoint is throttled per
 * account and per IP — but a five-character password does not survive an
 * *offline* attack. If the user table is ever disclosed, 600,000 PBKDF2
 * iterations buy minutes, not years, against a five-character keyspace. The
 * mitigation that matters at this floor is therefore keeping the database from
 * leaking, not the KDF.
 */
export const MIN_PASSWORD_LENGTH = 5;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Length-independent, content-constant-time comparison.
 *
 * Length is compared first and non-secretly: both operands here are digests of
 * fixed size, so an early length mismatch reveals nothing about the password.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] as number) ^ (b[i] as number);
  }
  return difference === 0;
}

export interface ParsedHash {
  algo: string;
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  // ["", "pbkdf2-sha256", "i=600000", "<salt>", "<hash>"]
  if (parts.length !== 5 || parts[0] !== "") return null;

  const algo = parts[1];
  const iterationPart = parts[2];
  const saltPart = parts[3];
  const hashPart = parts[4];
  if (!algo || !iterationPart || !saltPart || !hashPart) return null;
  if (!iterationPart.startsWith("i=")) return null;

  const iterations = Number.parseInt(iterationPart.slice(2), 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;

  try {
    return {
      algo,
      iterations,
      salt: fromBase64(saltPart),
      hash: fromBase64(hashPart),
    };
  } catch {
    return null;
  }
}

/** Hash a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await derive(password, salt, PBKDF2_ITERATIONS);
  return `$${PASSWORD_ALGO}$i=${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for malformed or unknown-algorithm hashes rather than
 * throwing, so a corrupt row cannot be distinguished from a wrong password by
 * an attacker watching responses.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  if (parsed.algo !== PASSWORD_ALGO) return false;

  const derived = await derive(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(derived, parsed.hash);
}

/**
 * True when a stored hash uses outdated parameters and should be replaced.
 * Call after a *successful* verification, then rehash with the plaintext still
 * in hand.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return true;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  return parsed.algo !== PASSWORD_ALGO || parsed.iterations < PBKDF2_ITERATIONS;
}

/**
 * SHA-256, hex encoded. Used for reset tokens (only the digest is stored) and
 * for hashing emails and IP addresses in the rate-limit log so that table is
 * not itself a source of personal data.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A high-entropy token for password reset and share links. */
export function newSecureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
