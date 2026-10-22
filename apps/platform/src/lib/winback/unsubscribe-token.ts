import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * The token in a win-back email's unsubscribe link.
 *
 * It names one recipient row — one campaign to one address — and carries an
 * HMAC under `AUTH_SECRET`, so a link cannot be forged to unsubscribe someone
 * else, and a guessed id is useless without the signature. `PREFIX` is inside
 * the signed payload, so no other signed link in the portal verifies here.
 *
 * It never expires. CAN-SPAM requires an opt-out to keep working for at least
 * thirty days after sending; a link that dies in someone's inbox a year later
 * would leave them no way out but the spam button, which costs the business
 * more than the email was worth.
 */

const PREFIX = "winback-unsubscribe";

function secret(): string | null {
  return process.env.AUTH_SECRET || null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(recipientPublicId: string, key: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`${PREFIX}.${recipientPublicId}`)),
  );
}

/** Null without a secret: the caller then refuses to send, never sends without a link. */
export async function signUnsubscribeToken(recipientPublicId: string): Promise<string | null> {
  const key = secret();
  if (!key) return null;
  return `${recipientPublicId}.${base64Url(await sign(recipientPublicId, key))}`;
}

/** The recipient's public id, or null for anything we did not sign. */
export async function verifyUnsubscribeToken(token: string): Promise<string | null> {
  const key = secret();
  if (!key || token.length > 200) return null;
  const [id, provided, extra] = token.split(".");
  if (!id || !provided || extra !== undefined || !/^[0-9A-Z]{26}$/.test(id)) return null;
  const expected = base64Url(await sign(id, key));
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(provided), encoder.encode(expected)) ? id : null;
}

/** The two addresses an email carries: the page (footer) and the one-click endpoint (header). */
export function unsubscribeUrls(origin: string, token: string): { page: string; oneClick: string } {
  const base = origin.replace(/\/$/, "");
  return { page: `${base}/unsubscribe/${token}`, oneClick: `${base}/api/unsubscribe/${token}` };
}
