import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * Resend's webhooks: what happened to an email after it left.
 *
 * Resend delivers through Svix, which signs `${id}.${timestamp}.${body}` with
 * HMAC-SHA-256. Two details are where a plausible implementation verifies
 * nothing:
 *
 *  - The secret is `whsec_` followed by **base64 of the key bytes**. Keyed
 *    with the secret's text instead, every real delivery fails — and a test
 *    that signs the same wrong way still passes.
 *  - The timestamp is inside the signed content, and checked against a
 *    five-minute window, so a captured delivery cannot be replayed later to
 *    suppress a customer or inflate an open rate.
 *
 * `svix-signature` can hold several space-separated `v1,<base64>` entries
 * while a secret is being rotated; any one matching is enough.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
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

async function hmac(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function keyOf(secret: string): Uint8Array | null {
  if (!secret.startsWith("whsec_")) return null;
  const key = base64ToBytes(secret.slice("whsec_".length));
  return key && key.length > 0 ? key : null;
}

export async function verifySvixSignature(input: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  secret: string | undefined;
  now?: Date;
}): Promise<boolean> {
  const { id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature || !input.secret) return false;
  const key = keyOf(input.secret);
  if (!key) return false;

  const sentAt = Number(timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isInteger(sentAt) || Math.abs(now - sentAt) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = await hmac(key, `${id}.${timestamp}.${body}`);
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const provided = base64ToBytes(value);
    return provided !== null && constantTimeEqual(provided, expected);
  });
}

/** Exposed for tests: the header a genuine delivery would carry. */
export async function svixSignatureFor(id: string, timestamp: string, body: string, secret: string): Promise<string> {
  const key = keyOf(secret);
  if (!key) throw new Error("Not a whsec_ secret.");
  return `v1,${bytesToBase64(await hmac(key, `${id}.${timestamp}.${body}`))}`;
}

/** The events win-back records. Everything else Resend sends is acknowledged and ignored. */
export type ResendEventType = "delivered" | "opened" | "clicked" | "bounced" | "complained";

const TYPES: Record<string, ResendEventType> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

export interface ResendEvent {
  type: ResendEventType;
  emailId: string;
  /** From the tag we set when sending, when Resend echoed it. */
  recipientPublicId: string | null;
  at: Date;
}

function tagValue(tags: unknown, name: string): string | null {
  if (Array.isArray(tags)) {
    const hit = tags.find((t) => t && typeof t === "object" && (t as { name?: unknown }).name === name);
    const value = hit ? (hit as { value?: unknown }).value : null;
    return typeof value === "string" ? value : null;
  }
  if (tags && typeof tags === "object") {
    const value = (tags as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  }
  return null;
}

/** Only after the signature has been verified. Null for anything win-back does not record. */
export function parseResendEvent(body: string): ResendEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { type, created_at: createdAt, data } = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  const mapped = typeof type === "string" ? TYPES[type] : undefined;
  if (!mapped || !data || typeof data !== "object") return null;
  const emailId = (data as { email_id?: unknown }).email_id;
  if (typeof emailId !== "string" || !emailId) return null;

  const at = typeof createdAt === "string" ? new Date(createdAt) : new Date();
  const recipient = tagValue((data as { tags?: unknown }).tags, "winback_recipient");
  return {
    type: mapped,
    emailId,
    recipientPublicId: recipient && /^[0-9A-Z]{26}$/.test(recipient) ? recipient : null,
    at: Number.isNaN(at.getTime()) ? new Date() : at,
  };
}
