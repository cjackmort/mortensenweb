import { isValidPublicId } from "@/lib/ids";
import { constantTimeEqual } from "@/lib/webhooks/signature";

/**
 * The tokens in a review request's links: `/review/<token>` (the tracked link
 * to Google) and `/review/<token>/stop` (unsubscribe).
 *
 * A token is the request's public id and an HMAC over it, so the public routes
 * can refuse a forged or mistyped link **before touching the database**. That
 * matters more than it looks: Neon bills for hours awake, and an endpoint that
 * queried on every random hit would let anyone keep it awake.
 *
 * Each token is signed for one purpose. A click link cannot be turned into an
 * unsubscribe link by editing the URL, and the other way round.
 *
 * There is no expiry. A customer may open the email weeks later, and the worst
 * an old link can do is record a click or an unsubscribe for its own request.
 * Rotating `AUTH_SECRET` does invalidate every link already sent; that is the
 * price of not storing a second secret, and the same one sessions already pay.
 */

export type ReviewTokenPurpose = "click" | "stop";

/** 16 bytes of HMAC-SHA-256: 128 bits, ample for a link that only reaches its own row. */
const SIGNATURE_BYTES = 16;

type Env = Record<string, string | undefined>;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(publicId: string, purpose: ReviewTokenPurpose, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`review:${purpose}:${publicId}`));
  return base64Url(new Uint8Array(mac).slice(0, SIGNATURE_BYTES));
}

/** Null without a signing secret: no link is better than an unsigned one. */
export async function signReviewToken(
  publicId: string,
  purpose: ReviewTokenPurpose,
  env: Env = process.env,
): Promise<string | null> {
  const secret = env.AUTH_SECRET;
  if (!secret) return null;
  return `${publicId}.${await signature(publicId, purpose, secret)}`;
}

/** The request's public id, or null for anything we did not sign for this purpose. */
export async function verifyReviewToken(
  token: string,
  purpose: ReviewTokenPurpose,
  env: Env = process.env,
): Promise<string | null> {
  const secret = env.AUTH_SECRET;
  if (!secret) return null;

  const [publicId, provided, extra] = token.split(".");
  if (!publicId || !provided || extra !== undefined || !isValidPublicId(publicId)) return null;

  const expected = await signature(publicId, purpose, secret);
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(provided), encoder.encode(expected)) ? publicId : null;
}
