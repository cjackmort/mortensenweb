/**
 * Short-lived links that let the agent see a client's photos.
 *
 * The gap this closes: a client uploads three pictures of the thing they want
 * changed, and the agent working in their repository could not see any of them.
 * `renderIssueBody` has always supported an attachments section, and no caller
 * ever passed one — so every request arrived as text alone, describing images
 * nobody could open.
 *
 * The agent runs on a GitHub Actions runner. It holds no session and cannot be
 * given one, so the ordinary tenant-scoped serving path is unreachable to it.
 * What it can do is fetch a URL, which makes a signed, expiring link the only
 * workable shape.
 *
 * ## What the signature is doing
 *
 * The token binds three things — which attachment, until when, and the fact
 * that we minted it. Without the HMAC, an attachment id in a URL would be a
 * bearer credential for anyone who guessed one. With it, forging a link means
 * forging an HMAC-SHA-256 under `AUTH_SECRET`.
 *
 * The expiry is inside the signed payload, not a query parameter beside it.
 * Signing `id` and reading `expires` from the URL would let anyone extend their
 * own access indefinitely.
 *
 * ## Why thirty minutes
 *
 * The infrastructure plan says ≤15 minutes for signed URLs. This uses 30, and
 * the reason is that the plan's figure was written for links handed to a person,
 * where the risk is a URL lingering in a browser or an inbox.
 *
 * These live in the body of an issue in a **private** repository, so the
 * population that can read one is already the population that can read the
 * whole repository. The expiry is defence in depth rather than the control, and
 * 30 minutes is what makes it actually work: it matches
 * `AGENT_JOB_TIMEOUT_MINUTES`, so a run that is queued behind other jobs still
 * finds the images live when it finally starts. A 15-minute link that has
 * expired by the time the agent reads it is not more secure — it just produces
 * a website built without the photos, silently.
 */

import { constantTimeEqual } from "@/lib/webhooks/signature";

const DEFAULT_TTL_MINUTES = 30;

function signingSecret(): string | null {
  // Reuses AUTH_SECRET rather than introducing another key to manage. Different
  // purpose, same trust domain: anyone holding it can already mint sessions,
  // so a separate secret would add operational burden without narrowing
  // anything meaningfully.
  return process.env.AUTH_SECRET ?? null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

/**
 * Mint a token for one attachment.
 *
 * Returns null when there is no signing secret. A caller must treat that as
 * "no attachment links", never as "link without a signature" — which is why
 * this returns null rather than falling back to an unsigned id.
 */
export async function signAttachmentToken(
  attachmentPublicId: string,
  { ttlMinutes = DEFAULT_TTL_MINUTES }: { ttlMinutes?: number } = {},
): Promise<string | null> {
  const secret = signingSecret();
  if (!secret) return null;

  const expiresAt = Date.now() + ttlMinutes * 60_000;
  const payload = `${attachmentPublicId}.${expiresAt}`;
  const signature = await sign(payload, secret);

  return `${base64UrlEncode(new TextEncoder().encode(payload))}.${base64UrlEncode(signature)}`;
}

export type TokenCheck =
  | { ok: true; attachmentPublicId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_configured" };

/**
 * Verify a token and recover the attachment it names.
 *
 * The signature is checked **before** the expiry. Reversing that order would
 * answer "this token is expired" for a payload we never signed, which tells an
 * attacker their forgery parsed — a small oracle, but a free one to avoid.
 */
export async function verifyAttachmentToken(token: string): Promise<TokenCheck> {
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: "not_configured" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const payloadBytes = base64UrlDecode(parts[0]!);
  const providedSignature = base64UrlDecode(parts[1]!);
  if (!payloadBytes || !providedSignature) return { ok: false, reason: "malformed" };

  const payload = new TextDecoder().decode(payloadBytes);
  const expected = await sign(payload, secret);

  if (!constantTimeEqual(providedSignature, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const separator = payload.lastIndexOf(".");
  if (separator < 1) return { ok: false, reason: "malformed" };

  const attachmentPublicId = payload.slice(0, separator);
  const expiresAt = Number(payload.slice(separator + 1));

  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };
  if (expiresAt < Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, attachmentPublicId };
}

/** Absolute URL the agent fetches. Null when signing is unavailable. */
export async function attachmentUrl(
  attachmentPublicId: string,
  options: { ttlMinutes?: number } = {},
): Promise<string | null> {
  const base = process.env.AUTH_URL;
  if (!base) return null;

  const token = await signAttachmentToken(attachmentPublicId, options);
  if (!token) return null;

  return `${base.replace(/\/$/, "")}/api/attachments/${token}`;
}

// ---------------------------------------------------------------------------
// Media library originals
// ---------------------------------------------------------------------------

/**
 * The same construction, for a media library asset.
 *
 * A separate function rather than a `kind` parameter on the one above, because
 * the thing that must not happen is a token minted for one table being accepted
 * by a route that reads the other. `MEDIA_PREFIX` goes *inside* the signed
 * payload, so a token for a request attachment and a token for a media asset
 * are not interchangeable even though both are 26-character public ids under
 * the same secret. Without the prefix they would be, and either route would
 * happily resolve the other's id against its own table.
 *
 * ## Why the agent gets the original
 *
 * It is generating the site's own optimised assets, and doing that from a
 * thumbnail produces a soft image on a real screen. The original is the only
 * correct input. That is also why these links must never end up in published
 * markup — they expire, and a page referencing one would silently lose its
 * image. The issue body says so explicitly where the agent will read it.
 */
const MEDIA_PREFIX = "media";

export async function signMediaAssetToken(
  assetPublicId: string,
  { ttlMinutes = DEFAULT_TTL_MINUTES }: { ttlMinutes?: number } = {},
): Promise<string | null> {
  const secret = signingSecret();
  if (!secret) return null;

  const expiresAt = Date.now() + ttlMinutes * 60_000;
  const payload = `${MEDIA_PREFIX}.${assetPublicId}.${expiresAt}`;
  const signature = await sign(payload, secret);

  return `${base64UrlEncode(new TextEncoder().encode(payload))}.${base64UrlEncode(signature)}`;
}

export type MediaTokenCheck =
  | { ok: true; assetPublicId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_configured" };

export async function verifyMediaAssetToken(token: string): Promise<MediaTokenCheck> {
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: "not_configured" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const payloadBytes = base64UrlDecode(parts[0]!);
  const providedSignature = base64UrlDecode(parts[1]!);
  if (!payloadBytes || !providedSignature) return { ok: false, reason: "malformed" };

  const payload = new TextDecoder().decode(payloadBytes);
  const expected = await sign(payload, secret);

  // Signature before expiry, for the same reason as above: answering "expired"
  // for a payload we never signed confirms to a forger that their guess parsed.
  if (!constantTimeEqual(providedSignature, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const segments = payload.split(".");
  if (segments.length !== 3 || segments[0] !== MEDIA_PREFIX) {
    return { ok: false, reason: "malformed" };
  }

  const expiresAt = Number(segments[2]);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };
  if (expiresAt < Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, assetPublicId: segments[1]! };
}

/** Absolute URL for one library original. Null when signing is unavailable. */
export async function mediaAssetUrl(
  assetPublicId: string,
  options: { ttlMinutes?: number } = {},
): Promise<string | null> {
  const base = process.env.AUTH_URL;
  if (!base) return null;

  const token = await signMediaAssetToken(assetPublicId, options);
  if (!token) return null;

  return `${base.replace(/\/$/, "")}/api/media/agent/${token}`;
}
