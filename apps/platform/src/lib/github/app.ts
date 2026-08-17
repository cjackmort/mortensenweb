/**
 * GitHub App authentication.
 *
 * The portal acts as a GitHub App, not as a user with a personal token. That
 * choice is what makes per-client isolation real: an installation token is
 * scoped to one installation and expires in an hour, so a leaked token cannot
 * reach every client repository and cannot be used indefinitely.
 *
 * Two things here are less obvious than they look:
 *
 * **WebCrypto, not `node:crypto`.** This runs in a Cloudflare Worker. Even with
 * `nodejs_compat`, signing through WebCrypto is the portable path and avoids
 * pulling a shim into the bundle.
 *
 * **GitHub hands you a PKCS#1 key; WebCrypto only imports PKCS#8.** The key you
 * download from the App settings page begins `-----BEGIN RSA PRIVATE KEY-----`,
 * which `crypto.subtle.importKey` rejects outright. Rather than making that a
 * documented setup footgun — where the failure surfaces at the first dispatch,
 * in production, as an opaque `DataError` — `toPkcs8` wraps it. Both formats
 * work, so pasting the key straight from GitHub is correct.
 *
 * This module never touches the Claude credential. `CLAUDE_CODE_OAUTH_TOKEN`
 * lives in GitHub Actions secrets and the portal has no code path that reads it.
 */

const JWT_LIFETIME_SECONDS = 540; // 9 minutes; GitHub rejects anything over 10.
const CLOCK_SKEW_SECONDS = 60;

/** Refresh an installation token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class GithubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubConfigError";
  }
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly documentationUrl?: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/**
 * Whether the App is configured at all.
 *
 * Mirrors `lib/analytics/umami.ts`: a feature with missing credentials reports
 * itself as unconfigured rather than throwing deep inside a request. The admin
 * UI uses this to explain what is missing instead of showing a stack trace.
 */
export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DER length prefix: short form under 128 bytes, long form above. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag: number, contents: Uint8Array): Uint8Array {
  const header = [tag, ...derLength(contents.length)];
  const out = new Uint8Array(header.length + contents.length);
  out.set(header, 0);
  out.set(contents, header.length);
  return out;
}

/**
 * The `rsaEncryption` AlgorithmIdentifier, DER-encoded:
 * `SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }`.
 */
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

/**
 * Wrap a PKCS#1 RSA key in the PKCS#8 envelope WebCrypto requires.
 *
 *   PrivateKeyInfo ::= SEQUENCE {
 *     version             INTEGER (0),
 *     privateKeyAlgorithm AlgorithmIdentifier,
 *     privateKey          OCTET STRING
 *   }
 */
function toPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = derWrap(0x04, pkcs1);

  const body = new Uint8Array(
    version.length + RSA_ALGORITHM_IDENTIFIER.length + privateKey.length,
  );
  body.set(version, 0);
  body.set(RSA_ALGORITHM_IDENTIFIER, version.length);
  body.set(privateKey, version.length + RSA_ALGORITHM_IDENTIFIER.length);

  return derWrap(0x30, body);
}

/**
 * Parse the configured PEM into a signing key.
 *
 * Accepts both `BEGIN RSA PRIVATE KEY` (PKCS#1, what GitHub gives you) and
 * `BEGIN PRIVATE KEY` (PKCS#8). Literal `\n` sequences are unescaped first,
 * because a multi-line PEM stored as a single secret value almost always
 * arrives with its newlines escaped.
 */
async function importSigningKey(): Promise<CryptoKey> {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) {
    throw new GithubConfigError("GITHUB_APP_PRIVATE_KEY is not set.");
  }

  const pem = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);

  const base64 = pem
    .replace(/-----(BEGIN|END)[^-]+-----/g, "")
    .replace(/\s+/g, "");

  if (!base64) {
    throw new GithubConfigError(
      "GITHUB_APP_PRIVATE_KEY does not look like a PEM private key.",
    );
  }

  let der: Uint8Array;
  try {
    der = base64ToBytes(base64);
  } catch {
    throw new GithubConfigError(
      "GITHUB_APP_PRIVATE_KEY is not valid base64. Check for truncation.",
    );
  }

  const pkcs8 = isPkcs1 ? toPkcs8(der) : der;

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8.buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new GithubConfigError(
      "GITHUB_APP_PRIVATE_KEY could not be imported as an RSA key.",
    );
  }
}

// ---------------------------------------------------------------------------
// App JWT
// ---------------------------------------------------------------------------

/**
 * A short-lived JWT proving we are the App.
 *
 * `iat` is backdated by a minute: GitHub rejects a token whose `iat` is in the
 * future, and Worker clocks are not guaranteed to agree with GitHub's to the
 * second.
 */
async function appJwt(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new GithubConfigError("GITHUB_APP_ID is not set.");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - CLOCK_SKEW_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: appId,
  };

  const encoder = new TextEncoder();
  const signingInput = `${bytesToBase64Url(
    encoder.encode(JSON.stringify(header)),
  )}.${bytesToBase64Url(encoder.encode(JSON.stringify(payload)))}`;

  const key = await importSigningKey();
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// Installation tokens
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Installation tokens are cached per installation for the life of the isolate.
 *
 * A Worker isolate is short-lived, so this is a modest saving rather than a
 * durable cache — but it keeps a burst of dispatches from minting a new token
 * per issue, which GitHub rate-limits.
 */
const tokenCache = new Map<string, CachedToken>();

export async function installationToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const jwt = await appJwt();
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mortensenweb-portal",
      },
    },
  );

  if (!response.ok) {
    // The body can echo request details; only the status is safe to surface.
    throw new GithubApiError(
      `Could not obtain an installation token (HTTP ${response.status}).`,
      response.status,
    );
  }

  const body = (await response.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  });

  return body.token;
}

/** Testing hook: drop cached installation tokens. */
export function resetTokenCache(): void {
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

export interface GithubRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Treat these statuses as a non-throwing result (e.g. 405 on a blocked merge). */
  allowStatuses?: number[];
}

/**
 * One authenticated call against the REST API.
 *
 * Errors carry the status and GitHub's message. That message is written for
 * developers and can quote request content, so callers log it internally and
 * never render it to a client.
 */
export async function githubRequest<T>(
  installationId: string,
  path: string,
  options: GithubRequestOptions = {},
): Promise<{ status: number; data: T }> {
  const token = await installationToken(installationId);
  const { method = "GET", body, allowStatuses = [] } = options;

  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mortensenweb-portal",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok && !allowStatuses.includes(response.status)) {
    let message = `GitHub request failed (HTTP ${response.status}).`;
    let documentationUrl: string | undefined;
    try {
      const problem = (await response.json()) as {
        message?: string;
        documentation_url?: string;
      };
      if (problem.message) message = `${message} ${problem.message}`;
      documentationUrl = problem.documentation_url;
    } catch {
      // A non-JSON error body is not worth failing over.
    }
    throw new GithubApiError(message, response.status, documentationUrl);
  }

  const data =
    response.status === 204
      ? (undefined as T)
      : ((await response.json().catch(() => undefined)) as T);

  return { status: response.status, data };
}
