import { constantTimeEqual } from "@/lib/webhooks/signature";
import type { NetlifySubmissionPayload } from "@/lib/netlify/api";

/**
 * Netlify Forms → leads: signature checks and parsing, kept pure so the parts
 * that decide what a submission *is* can be tested without a network.
 *
 * ## One secret per site
 *
 * Netlify signs each outgoing webhook with the secret given when the hook was
 * created. Every site's hook gets its own, derived from one master secret and
 * the site's public id, and its own URL naming that site. A delivery is
 * accepted for a site only if it verifies under *that site's* secret — so the
 * signature itself proves which site it came from, and nothing in the body
 * (whose `site_url` a form on any site could influence) decides which client's
 * inbox it lands in.
 */

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) return null;
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The signing secret for one site's hook. Never stored; recomputed on each delivery. */
export async function siteHookSecret(
  masterSecret: string,
  sitePublicId: string,
): Promise<string> {
  // The prefix scopes the derivation, so this master secret could sign
  // something else one day without a forms secret being reusable there.
  return toHex(await hmac(masterSecret, `netlify-forms-hook:${sitePublicId}`));
}

/**
 * Verify `X-Webhook-Signature`.
 *
 * Netlify sends an HS256 JWT whose claims are `iss: "netlify"` and `sha256`,
 * the hex digest of the raw body. Both halves are checked: the JWT signature
 * proves Netlify issued the token, and the digest proves the token belongs to
 * *this* body. Checking only the first would accept any captured token with a
 * substituted body.
 *
 * The algorithm is pinned rather than read from the token's header — trusting
 * `alg` is the classic JWT downgrade, `none` included.
 */
export async function verifyNetlifySignature(
  rawBody: string,
  token: string | null,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];

  const provided = base64UrlToBytes(signature);
  if (!provided) return false;
  const expected = await hmac(secret, `${header}.${payload}`);
  if (!constantTimeEqual(provided, expected)) return false;

  let claims: { iss?: unknown; sha256?: unknown };
  try {
    const decoded = base64UrlToBytes(payload);
    if (!decoded) return false;
    claims = JSON.parse(new TextDecoder().decode(decoded)) as typeof claims;
  } catch {
    return false;
  }
  if (claims.iss !== "netlify" || typeof claims.sha256 !== "string") return false;

  const bodyDigest = toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rawBody))),
  );
  return constantTimeEqual(
    encoder.encode(claims.sha256.toLowerCase()),
    encoder.encode(bodyDigest),
  );
}

/** Exposed for tests: the header a genuine delivery of `rawBody` would carry. */
export async function netlifySignatureFor(rawBody: string, secret: string): Promise<string> {
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const digest = toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rawBody))),
  );
  const payload = bytesToBase64Url(
    encoder.encode(JSON.stringify({ iss: "netlify", sha256: digest })),
  );
  const signature = bytesToBase64Url(await hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface LeadField {
  label: string;
  value: string;
}

export interface ParsedLead {
  submissionId: string;
  formName: string | null;
  receivedAt: Date | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  fields: LeadField[];
  pageUrl: string | null;
}

const MAX_FIELDS = 50;
const MAX_VALUE = 5000;
const MAX_LABEL = 200;

/**
 * Fields that are Netlify's bookkeeping or a spam trap, not anything the
 * visitor told the business. A honeypot field with a value in it is the
 * reason Netlify filtered something, and showing it would only confuse.
 */
const NOT_THE_VISITORS = new Set([
  "ip",
  "user_agent",
  "referrer",
  "form-name",
  "form_name",
  "bot-field",
  "bot_field",
  "honeypot",
  "_gotcha",
  "g-recaptcha-response",
]);

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value).replace(/\r\n?/g, "\n").trim().slice(0, MAX_VALUE);
}

/** `phone_number` → `Phone number`. Only used when the form gave no label. */
function humanise(name: string): string {
  const spaced = name.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function collectFields(payload: NetlifySubmissionPayload): Array<LeadField & { key: string }> {
  const out: Array<LeadField & { key: string }> = [];

  // Netlify's own ordered list carries the labels as the form showed them.
  // `data` is the fallback for payloads without it, and has only names.
  if (Array.isArray(payload.ordered_human_fields)) {
    for (const entry of payload.ordered_human_fields as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const { name, title, value } = entry as { name?: unknown; title?: unknown; value?: unknown };
      const key = typeof name === "string" ? name : typeof title === "string" ? title : "";
      if (!key || NOT_THE_VISITORS.has(key.toLowerCase())) continue;
      const text = asText(value);
      if (!text) continue;
      const label = (typeof title === "string" && title.trim() ? title.trim() : humanise(key)).slice(0, MAX_LABEL);
      out.push({ key, label, value: text });
    }
  } else if (payload.data && typeof payload.data === "object") {
    for (const [key, value] of Object.entries(payload.data as Record<string, unknown>)) {
      if (NOT_THE_VISITORS.has(key.toLowerCase())) continue;
      const text = asText(value);
      if (!text) continue;
      out.push({ key, label: humanise(key).slice(0, MAX_LABEL), value: text });
    }
  }

  return out.slice(0, MAX_FIELDS);
}

function pick(
  fields: Array<LeadField & { key: string }>,
  pattern: RegExp,
): string | null {
  const match = fields.find((f) => pattern.test(f.key) || pattern.test(f.label));
  return match ? match.value : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Turn an untrusted submission into a lead, or refuse it.
 *
 * Only a missing id is a refusal: without Netlify's id there is no way to tell
 * a redelivery from a new enquiry. Everything else degrades — a form with no
 * recognisable email field still produces a lead, with its fields intact,
 * because a lead the client can read is better than one we discarded for
 * being oddly shaped.
 */
export function parseSubmission(
  payload: NetlifySubmissionPayload,
): { ok: true; lead: ParsedLead } | { ok: false } {
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!id || id.length > 100) return { ok: false };

  const fields = collectFields(payload);

  const created = typeof payload.created_at === "string" ? new Date(payload.created_at) : null;
  const receivedAt = created && !Number.isNaN(created.getTime()) ? created : null;

  const first = pick(fields, /^first[-_ ]?name$|^first$/i);
  const last = pick(fields, /^last[-_ ]?name$|^surname$|^last$/i);
  const name =
    asText(payload.name) ||
    pick(fields, /^(full[-_ ]?|your[-_ ]?|contact[-_ ]?)?name$/i) ||
    [first, last].filter(Boolean).join(" ") ||
    null;

  const emailCandidate = asText(payload.email) || pick(fields, /e-?mail/i) || "";
  const email = EMAIL.test(emailCandidate) ? emailCandidate.slice(0, 254) : null;

  const phone = pick(fields, /phone|tel(ephone)?$|mobile|cell/i);
  const message = pick(
    fields,
    /message|comments?|details|enquiry|inquiry|question|notes?|description|project|help/i,
  );

  const data = payload.data && typeof payload.data === "object"
    ? (payload.data as Record<string, unknown>)
    : {};

  return {
    ok: true,
    lead: {
      submissionId: id,
      formName: typeof payload.form_name === "string" ? payload.form_name.slice(0, MAX_LABEL) : null,
      receivedAt,
      name: name ? name.slice(0, MAX_LABEL) : null,
      email,
      phone: phone ? phone.slice(0, 60) : null,
      message,
      fields: fields.map(({ label, value }) => ({ label, value })),
      pageUrl: webUrl(data.referrer),
    },
  };
}
