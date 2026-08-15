/**
 * Public identifiers.
 *
 * Every row exposed in a URL or API response carries a `public_id` generated
 * here. Sequential integers and UUIDv4 are both avoidable information leaks:
 * the first reveals record counts and ordering, the second reveals nothing but
 * is long and awkward in URLs.
 *
 * These are 128 bits of CSPRNG output in Crockford base32 — 26 characters,
 * URL-safe, case-insensitive, and with no visually ambiguous letters (I, L, O,
 * and U are excluded), so a client can read one over the phone.
 *
 * Unguessability is the *second* barrier, never the only one: every lookup is
 * additionally scoped by `org_id` in the repository layer.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_BYTES = 16; // 128 bits

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return output;
}

/** A new 26-character public identifier. */
export function newPublicId(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  return encodeCrockford(bytes);
}

/**
 * Prefixed identifier, e.g. `req_3F7K...`. The prefix is a readability aid in
 * logs and support conversations; it carries no authority and is never parsed
 * to decide access.
 */
export function newPrefixedId(prefix: string): string {
  return `${prefix}_${newPublicId()}`;
}

const PUBLIC_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Shape check only. A well-formed identifier is not an authorised one — the
 * repository layer still scopes every query by tenant.
 */
export function isValidPublicId(candidate: string): boolean {
  return PUBLIC_ID_PATTERN.test(candidate.toUpperCase());
}

/** Normalise user-entered identifiers: Crockford base32 is case-insensitive. */
export function normalisePublicId(candidate: string): string {
  return candidate.trim().toUpperCase();
}
