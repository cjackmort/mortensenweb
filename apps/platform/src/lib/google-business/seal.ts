/**
 * Sealing the agency's Google refresh token for storage.
 *
 * The refresh token is the one long-lived credential in this integration: it
 * can edit every client profile the agency manages, until the operator revokes
 * it. So it is never written to the database in the clear. libsodium's
 * `crypto_secretbox_easy` (XSalsa20-Poly1305) under `GOOGLE_TOKEN_KEY`, with a
 * fresh random nonce per seal; a tampered or truncated value fails
 * authentication rather than decrypting to garbage.
 *
 * The key lives only in the environment, not beside the ciphertext, so a
 * database dump alone does not yield a usable token.
 *
 * Stored as `v1.<base64(nonce || ciphertext)>`. The version prefix is there so
 * a future key rotation can tell old values from new without guessing.
 *
 * libsodium is already a dependency for GitHub's sealed secrets
 * (`lib/github/secrets.ts`) and is loaded the same way: a dynamic import, so
 * the WASM is only pulled in on the paths that actually touch a token.
 */

const VERSION = "v1";
const KEY_BYTES = 32;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

async function sodiumReady() {
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;
  return sodium;
}

function keyBytes(sodium: Awaited<ReturnType<typeof sodiumReady>>, keyBase64: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = sodium.from_base64(keyBase64.trim(), sodium.base64_variants.ORIGINAL);
  } catch {
    throw new SealError("GOOGLE_TOKEN_KEY is not valid base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new SealError(`GOOGLE_TOKEN_KEY must be ${KEY_BYTES} bytes; it is ${key.length}.`);
  }
  return key;
}

export async function sealSecret(plaintext: string, keyBase64: string): Promise<string> {
  const sodium = await sodiumReady();
  const key = keyBytes(sodium, keyBase64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);

  const joined = new Uint8Array(nonce.length + box.length);
  joined.set(nonce, 0);
  joined.set(box, nonce.length);
  return `${VERSION}.${sodium.to_base64(joined, sodium.base64_variants.ORIGINAL)}`;
}

export async function openSecret(sealed: string, keyBase64: string): Promise<string> {
  const sodium = await sodiumReady();
  const key = keyBytes(sodium, keyBase64);

  const [version, body] = sealed.split(".", 2);
  if (version !== VERSION || !body) throw new SealError("Unrecognised sealed value.");

  let joined: Uint8Array;
  try {
    joined = sodium.from_base64(body, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new SealError("Sealed value is not valid base64.");
  }
  const nonceBytes = sodium.crypto_secretbox_NONCEBYTES;
  if (joined.length <= nonceBytes) throw new SealError("Sealed value is truncated.");

  try {
    const opened = sodium.crypto_secretbox_open_easy(
      joined.slice(nonceBytes),
      joined.slice(0, nonceBytes),
      key,
    );
    return sodium.to_string(opened);
  } catch {
    // Wrong key, or the value was altered. Either way it is unusable, and
    // saying which would only help someone probing for the key.
    throw new SealError("Sealed value could not be opened with GOOGLE_TOKEN_KEY.");
  }
}
