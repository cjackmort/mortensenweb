import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, googleConnections } from "@/db/schema";
import { googleBusinessConfig, type GoogleBusinessConfig } from "@/lib/google-business/config";
import { createGoogleBusinessClient, type GoogleBusinessClient } from "@/lib/google-business/client";
import { GoogleApiError, type GoogleErrorKind } from "@/lib/google-business/errors";
import {
  exchangeCode,
  fetchIdentity,
  grantsBusinessScope,
  refreshAccessToken,
  revokeToken,
} from "@/lib/google-business/oauth";
import { openSecret, sealSecret } from "@/lib/google-business/seal";
import type { AdminContext } from "../context";

/**
 * The agency's one Google connection: whether it exists, whether Google is
 * actually letting it do anything, and the wrapper every call to Google goes
 * through.
 *
 * ## The states, and why "connected" is not enough
 *
 * Signing in with Google can succeed while every API call fails. A Business
 * Profile project gets a quota of **zero** until Google approves its API
 * access request, so the OAuth flow completes, a refresh token arrives, and
 * then each call answers 429. Showing that as "connected" would tell the
 * operator it works; showing it as "not connected" would send them to
 * reconnect, which changes nothing. So it is a state of its own, `no_access`,
 * decided by `last_success_at`: a connection that has never had a call
 * succeed and is being refused for quota has no access yet. One that has
 * worked before and gets a 429 is just being rate-limited, and pauses.
 *
 * ## Errors on the row
 *
 * `last_error` is stored as `<kind>: <message>`, the kind being a
 * `GoogleErrorKind`, so the state can be decided from the row alone without
 * a call to Google on every page view.
 */

/** How long to stop calling Google after a 429 that gave no Retry-After. */
export const QUOTA_PAUSE_MS = 10 * 60 * 1000;
/** How often to re-check a connection Google has not granted access to yet. */
export const ACCESS_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type GoogleConnectionStatus =
  | { state: "not_configured"; missing: string[]; redirectUri: string | null }
  | { state: "not_connected"; redirectUri: string }
  | { state: "needs_reconnect"; email: string; message: string; redirectUri: string }
  | {
      state: "no_access";
      email: string;
      reason: "quota" | "api_disabled";
      message: string;
      checkedAt: Date | null;
      connectedAt: Date;
    }
  | {
      state: "connected";
      email: string;
      connectedAt: Date;
      lastSuccessAt: Date | null;
      /** Rate-limited: calls resume after this. */
      pausedUntil: Date | null;
      /** The last failure, when the last call failed for a reason that is not quota. */
      lastError: string | null;
    };

interface ConnectionRow {
  id: string;
  googleEmail: string;
  refreshTokenSealed: string;
  connectedAt: Date;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
  quotaPausedUntil: Date | null;
}

export async function liveConnection(db: Database): Promise<ConnectionRow | null> {
  const [row] = await db
    .select({
      id: googleConnections.id,
      googleEmail: googleConnections.googleEmail,
      refreshTokenSealed: googleConnections.refreshTokenSealed,
      connectedAt: googleConnections.connectedAt,
      lastError: googleConnections.lastError,
      lastErrorAt: googleConnections.lastErrorAt,
      lastSuccessAt: googleConnections.lastSuccessAt,
      quotaPausedUntil: googleConnections.quotaPausedUntil,
    })
    .from(googleConnections)
    .where(isNull(googleConnections.revokedAt))
    .limit(1);
  return row ?? null;
}

export function errorKindOf(lastError: string | null): GoogleErrorKind | null {
  const kind = lastError?.split(":", 1)[0];
  const known: GoogleErrorKind[] = ["quota", "auth", "api_disabled", "permission", "not_found", "invalid", "unavailable"];
  return known.find((k) => k === kind) ?? null;
}

function messageOf(lastError: string | null): string {
  return lastError?.replace(/^[a-z_]+:\s*/, "") ?? "";
}

export function statusFrom(row: ConnectionRow | null, config: ReturnType<typeof googleBusinessConfig>, now = new Date()): GoogleConnectionStatus {
  if (!config.ok) return { state: "not_configured", missing: config.missing, redirectUri: config.redirectUri };
  const redirectUri = config.config.redirectUri;
  if (!row) return { state: "not_connected", redirectUri };

  const kind = errorKindOf(row.lastError);
  if (kind === "auth") {
    return { state: "needs_reconnect", email: row.googleEmail, message: messageOf(row.lastError), redirectUri };
  }
  if (kind === "api_disabled" || (kind === "quota" && row.lastSuccessAt === null)) {
    return {
      state: "no_access",
      email: row.googleEmail,
      reason: kind,
      message: messageOf(row.lastError),
      checkedAt: row.lastErrorAt,
      connectedAt: row.connectedAt,
    };
  }
  return {
    state: "connected",
    email: row.googleEmail,
    connectedAt: row.connectedAt,
    lastSuccessAt: row.lastSuccessAt,
    pausedUntil: row.quotaPausedUntil && row.quotaPausedUntil > now ? row.quotaPausedUntil : null,
    lastError: kind && kind !== "quota" ? messageOf(row.lastError) : null,
  };
}

export async function getGoogleConnectionStatus(db: Database): Promise<GoogleConnectionStatus> {
  return statusFrom(await liveConnection(db), googleBusinessConfig());
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

/**
 * Access tokens last an hour; minting one per call would spend a token
 * request per page action. Cached per server instance and per connection, so
 * a reconnect never serves the old account's token.
 */
let cached: { connectionId: string; token: string; expiresAt: number } | null = null;
const TOKEN_MARGIN_MS = 60 * 1000;

/** Testing hook, and called on disconnect. */
export function resetGoogleTokenCache(): void {
  cached = null;
}

async function accessTokenFor(row: ConnectionRow, config: GoogleBusinessConfig): Promise<string> {
  if (cached && cached.connectionId === row.id && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const refreshToken = await openSecret(row.refreshTokenSealed, config.tokenKey);
  const grant = await refreshAccessToken(config, refreshToken);
  cached = { connectionId: row.id, token: grant.accessToken, expiresAt: grant.expiresAt.getTime() };
  return grant.accessToken;
}

export class GoogleUnavailableError extends Error {
  readonly status: GoogleConnectionStatus;
  constructor(status: GoogleConnectionStatus, message: string) {
    super(message);
    this.name = "GoogleUnavailableError";
    this.status = status;
  }
}

/** What an operator is told when Google cannot be used at all right now. */
export function unavailableMessage(status: GoogleConnectionStatus): string {
  switch (status.state) {
    case "not_configured":
      return "Google is not set up on this server yet. See the setup checklist under Google.";
    case "not_connected":
      return "The agency's Google account is not connected yet.";
    case "needs_reconnect":
      return "Google no longer accepts the agency's sign-in. Reconnect the Google account.";
    case "no_access":
      return status.reason === "quota"
        ? "Google has not granted this project Business Profile API access yet (its quota is 0)."
        : "A Business Profile API is not enabled in the Google Cloud project.";
    case "connected":
      return status.pausedUntil
        ? `Google is limiting requests. Try again after ${status.pausedUntil.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`
        : "Google could not be reached.";
  }
}

async function recordSuccess(db: Database, connectionId: string, now: Date): Promise<void> {
  await db
    .update(googleConnections)
    .set({ lastSuccessAt: now, lastError: null, lastErrorAt: null, quotaPausedUntil: null, updatedAt: now })
    .where(eq(googleConnections.id, connectionId));
}

async function recordFailure(db: Database, connectionId: string, error: GoogleApiError, now: Date): Promise<void> {
  // Only failures that are about the connection itself go on the connection.
  // A refused edit or one client's missing permission is that client's
  // problem, recorded on their location or shown on the form.
  if (!["quota", "auth", "api_disabled"].includes(error.kind)) return;
  const pause =
    error.kind === "quota"
      ? new Date(now.getTime() + (error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : QUOTA_PAUSE_MS))
      : null;
  await db
    .update(googleConnections)
    .set({
      lastError: `${error.kind}: ${error.message}`.slice(0, 1000),
      lastErrorAt: now,
      ...(pause ? { quotaPausedUntil: pause } : {}),
      updatedAt: now,
    })
    .where(eq(googleConnections.id, connectionId));
  if (error.kind === "auth") resetGoogleTokenCache();
}

/**
 * Run `fn` against Google as the agency, recording what happened on the
 * connection: a success clears any error and the quota pause; a quota, auth
 * or disabled-API failure is written to the row (and a 429 pauses every
 * caller). Throws `GoogleUnavailableError` without calling Google when the
 * connection cannot be used, and `GoogleApiError` when Google refused.
 */
export async function withGoogle<T>(
  db: Database,
  fn: (client: GoogleBusinessClient) => Promise<T>,
  { now = new Date(), ignorePause = false }: { now?: Date; ignorePause?: boolean } = {},
): Promise<T> {
  const config = googleBusinessConfig();
  const row = await liveConnection(db);
  const status = statusFrom(row, config, now);
  if (!config.ok || !row) throw new GoogleUnavailableError(status, unavailableMessage(status));
  if (status.state === "needs_reconnect") throw new GoogleUnavailableError(status, unavailableMessage(status));
  if (!ignorePause && row.quotaPausedUntil && row.quotaPausedUntil > now) {
    // Not even one call while paused: the quota is the whole project's, and a
    // call made now only pushes the pause out further.
    throw new GoogleApiError("quota", 429, `Paused for Google's quota until ${row.quotaPausedUntil.toISOString()}.`);
  }

  try {
    const token = await accessTokenFor(row, config.config);
    const result = await fn(createGoogleBusinessClient(token));
    await recordSuccess(db, row.id, new Date());
    return result;
  } catch (error) {
    if (error instanceof GoogleApiError) await recordFailure(db, row.id, error, new Date());
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Connecting and disconnecting
// ---------------------------------------------------------------------------

export type ConnectResult =
  | { ok: true; email: string; status: GoogleConnectionStatus }
  | { ok: false; message: string };

/**
 * Finish the OAuth flow: exchange the code, find out which account it is,
 * seal the refresh token, retire any previous connection, and make one call
 * to see whether Google will actually let the account do anything.
 */
export async function completeGoogleConnect(
  ctx: AdminContext,
  db: Database,
  { code, codeVerifier }: { code: string; codeVerifier: string },
): Promise<ConnectResult> {
  const config = googleBusinessConfig();
  if (!config.ok) return { ok: false, message: "Google is not set up on this server yet." };

  let grant;
  let identity;
  try {
    grant = await exchangeCode(config.config, code, codeVerifier);
    identity = await fetchIdentity(grant.accessToken);
  } catch (error) {
    console.error("[google] connect failed", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "Google did not complete the sign-in. Try connecting again." };
  }
  if (!grant.refreshToken) {
    return { ok: false, message: "Google did not grant offline access. Try connecting again." };
  }
  if (!grantsBusinessScope(grant.scope)) {
    return {
      ok: false,
      message: "Google did not grant permission to manage Business Profiles. Tick that box on Google's consent screen.",
    };
  }

  const sealed = await sealSecret(grant.refreshToken, config.config.tokenKey);
  const now = new Date();

  const previous = await liveConnection(db);
  if (previous) {
    await db
      .update(googleConnections)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(googleConnections.id, previous.id), isNull(googleConnections.revokedAt)));
  }
  resetGoogleTokenCache();

  const [row] = await db
    .insert(googleConnections)
    .values({
      googleEmail: identity.email,
      googleSubject: identity.subject,
      scope: grant.scope,
      refreshTokenSealed: sealed,
      connectedBy: ctx.userId,
      connectedAt: now,
    })
    .returning({ id: googleConnections.id });
  cached = { connectionId: row!.id, token: grant.accessToken, expiresAt: grant.expiresAt.getTime() };

  await db.insert(auditLog).values({
    action: "google.connected",
    entityType: "google_connection",
    entityId: row!.id,
    actorUserId: ctx.userId,
    metadata: { email: identity.email, replaced: previous?.googleEmail ?? null },
  });

  // One cheap call, to learn now rather than at the first sync whether the
  // project has API access. Its outcome lands on the row either way.
  await probeGoogleAccess(db).catch(() => undefined);

  return { ok: true, email: identity.email, status: await getGoogleConnectionStatus(db) };
}

/** List the agency's accounts once; records whether Google allowed it. */
export async function probeGoogleAccess(db: Database): Promise<boolean> {
  try {
    await withGoogle(db, (google) => google.listAccounts(), { ignorePause: true });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectGoogle(ctx: AdminContext, db: Database): Promise<{ ok: true; message: string }> {
  const row = await liveConnection(db);
  if (!row) return { ok: true, message: "Google was not connected." };

  const config = googleBusinessConfig();
  if (config.ok) {
    // Revoking at Google too, so the token is dead even if this database
    // leaks later. Best effort: Google may already have forgotten it.
    try {
      await revokeToken(await openSecret(row.refreshTokenSealed, config.config.tokenKey));
    } catch {
      // A token that cannot be opened cannot be used either.
    }
  }

  const now = new Date();
  await db
    .update(googleConnections)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(googleConnections.id, row.id));
  resetGoogleTokenCache();
  await db.insert(auditLog).values({
    action: "google.disconnected",
    entityType: "google_connection",
    entityId: row.id,
    actorUserId: ctx.userId,
    metadata: { email: row.googleEmail },
  });
  return { ok: true, message: `Disconnected ${row.googleEmail}. Client profiles stay linked and resume when Google is connected again.` };
}
