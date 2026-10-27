import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, connectedAccounts, sites } from "@/db/schema";
import type { ConnectionProvider, ConnectionStatus } from "@/db/schema/connections";
import { providerAdapter, type ProviderAdapter } from "@/lib/connections";
import { openToken, sealToken } from "@/lib/connections/seal";
import {
  hostOf,
  parseAudit,
  ProviderError,
  type Audit,
  type ProviderGrant,
  type ProviderTokens,
  type TokenUpdate,
} from "@/lib/connections/types";
import { newPublicId } from "@/lib/ids";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * A client's connected accounts, tenant-scoped.
 *
 * Tokens go in sealed and come out only inside `runAudit`, for the one call
 * that needs them. What the page and the report read is the stored audit.
 */

export interface ConnectedAccountView {
  publicId: string;
  provider: ConnectionProvider;
  displayName: string | null;
  status: ConnectionStatus;
  connectedAt: Date;
  lastAuditAt: Date | null;
  lastAudit: Audit | null;
  lastError: string | null;
}

const liveFor = (organizationId: string, provider?: ConnectionProvider) =>
  and(
    eq(connectedAccounts.organizationId, organizationId),
    isNull(connectedAccounts.revokedAt),
    ...(provider ? [eq(connectedAccounts.provider, provider)] : []),
  );

export async function listConnectedAccounts(db: Database, ctx: TenantContext): Promise<ConnectedAccountView[]> {
  const rows = await db
    .select({
      publicId: connectedAccounts.publicId,
      provider: connectedAccounts.provider,
      displayName: connectedAccounts.displayName,
      status: connectedAccounts.status,
      connectedAt: connectedAccounts.connectedAt,
      lastAuditAt: connectedAccounts.lastAuditAt,
      lastAudit: connectedAccounts.lastAudit,
      lastError: connectedAccounts.lastError,
    })
    .from(connectedAccounts)
    .where(liveFor(ctx.organizationId))
    .orderBy(asc(connectedAccounts.connectedAt));
  return rows.map((row) => ({ ...row, lastAudit: parseAudit(row.lastAudit) }));
}

/**
 * Keep what the provider granted. A live row for the same provider is
 * replaced — reconnecting is how a client fixes a lapsed token — and the old
 * one stays as revoked history.
 */
export async function completeConnect(
  db: Database,
  ctx: TenantContext,
  provider: ConnectionProvider,
  grant: ProviderGrant,
  now: Date = new Date(),
): Promise<{ publicId: string }> {
  assertMutable(ctx);

  await db
    .update(connectedAccounts)
    .set({
      status: "revoked",
      revokedAt: now,
      accessTokenSealed: null,
      refreshTokenSealed: null,
      updatedAt: now,
    })
    .where(liveFor(ctx.organizationId, provider));

  const publicId = newPublicId();
  await db.insert(connectedAccounts).values({
    publicId,
    organizationId: ctx.organizationId,
    provider,
    externalId: grant.externalId,
    displayName: grant.displayName,
    scope: grant.scope,
    accessTokenSealed: grant.accessToken ? await sealToken(grant.accessToken) : null,
    refreshTokenSealed: grant.refreshToken ? await sealToken(grant.refreshToken) : null,
    tokenExpiresAt: grant.expiresAt,
    status: "connected",
    connectedBy: ctx.userId,
    connectedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "connection.connected",
    entityType: "connected_account",
    entityId: publicId,
    metadata: { provider, externalId: grant.externalId },
    createdAt: now,
  });

  return { publicId };
}

/**
 * End a connection. The provider is told, best effort; the row is revoked
 * and its tokens cleared whatever the provider said, because a client who
 * pressed Disconnect must see it gone.
 */
export async function disconnect(
  db: Database,
  ctx: TenantContext,
  provider: ConnectionProvider,
  deps: { adapter?: ProviderAdapter } = {},
  now: Date = new Date(),
): Promise<boolean> {
  assertMutable(ctx);
  const [row] = await db
    .select({
      id: connectedAccounts.id,
      publicId: connectedAccounts.publicId,
      externalId: connectedAccounts.externalId,
      accessTokenSealed: connectedAccounts.accessTokenSealed,
      refreshTokenSealed: connectedAccounts.refreshTokenSealed,
      tokenExpiresAt: connectedAccounts.tokenExpiresAt,
    })
    .from(connectedAccounts)
    .where(liveFor(ctx.organizationId, provider))
    .limit(1);
  if (!row) return false;

  try {
    const tokens = await openTokens(row);
    await (deps.adapter ?? providerAdapter(provider)).revoke(tokens);
  } catch (error) {
    console.warn("[connections] provider revoke failed", {
      provider,
      message: error instanceof Error ? error.message : "unknown",
    });
  }

  await db
    .update(connectedAccounts)
    .set({
      status: "revoked",
      revokedAt: now,
      accessTokenSealed: null,
      refreshTokenSealed: null,
      updatedAt: now,
    })
    .where(eq(connectedAccounts.id, row.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    action: "connection.disconnected",
    entityType: "connected_account",
    entityId: row.publicId,
    metadata: { provider },
    createdAt: now,
  });
  return true;
}

async function openTokens(row: {
  externalId: string;
  accessTokenSealed: string | null;
  refreshTokenSealed: string | null;
  tokenExpiresAt: Date | null;
}): Promise<ProviderTokens> {
  return {
    externalId: row.externalId,
    accessToken: row.accessTokenSealed ? await openToken(row.accessTokenSealed) : null,
    refreshToken: row.refreshTokenSealed ? await openToken(row.refreshTokenSealed) : null,
    expiresAt: row.tokenExpiresAt,
  };
}

/** The site's host, for checks like "does the bio link here". The first site is the business's. */
export async function siteHostFor(db: Database, organizationId: string): Promise<string | null> {
  const [site] = await db
    .select({ primaryDomain: sites.primaryDomain })
    .from(sites)
    .where(eq(sites.organizationId, organizationId))
    .orderBy(asc(sites.createdAt))
    .limit(1);
  return hostOf(site?.primaryDomain);
}

export type AuditRun =
  | { ok: true; audit: Audit }
  | { ok: false; reason: "not_connected" | "needs_reconnect" | "unavailable"; message: string };

/**
 * Look at one connected account now, and keep what was found.
 *
 * A provider saying the grant is no longer good marks the row
 * `needs_reconnect` — the page then offers Connect again — while a passing
 * outage records the error and leaves the last good audit in place.
 */
export async function runAudit(
  db: Database,
  organizationId: string,
  provider: ConnectionProvider,
  deps: { adapter?: ProviderAdapter; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<AuditRun> {
  const now = deps.now ?? new Date();
  const [row] = await db
    .select({
      id: connectedAccounts.id,
      status: connectedAccounts.status,
      externalId: connectedAccounts.externalId,
      accessTokenSealed: connectedAccounts.accessTokenSealed,
      refreshTokenSealed: connectedAccounts.refreshTokenSealed,
      tokenExpiresAt: connectedAccounts.tokenExpiresAt,
    })
    .from(connectedAccounts)
    .where(liveFor(organizationId, provider))
    .limit(1);
  if (!row) return { ok: false, reason: "not_connected", message: "Not connected." };
  if (row.status === "needs_reconnect") {
    return { ok: false, reason: "needs_reconnect", message: "The connection lapsed. Connect it again." };
  }

  const adapter = deps.adapter ?? providerAdapter(provider);
  try {
    const tokens = await openTokens(row);
    const siteHost = await siteHostFor(db, organizationId);
    const outcome = await adapter.audit(tokens, { siteHost, now, fetchImpl: deps.fetchImpl });
    await db
      .update(connectedAccounts)
      .set({
        lastAudit: outcome.audit,
        lastAuditAt: now,
        lastError: null,
        lastErrorAt: null,
        updatedAt: now,
        ...(await sealedUpdate(outcome.tokens)),
      })
      .where(eq(connectedAccounts.id, row.id));
    return { ok: true, audit: outcome.audit };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const lapsed = error instanceof ProviderError && error.kind === "auth";
    await db
      .update(connectedAccounts)
      .set({
        lastError: message.slice(0, 500),
        lastErrorAt: now,
        updatedAt: now,
        ...(lapsed ? { status: "needs_reconnect" as const } : {}),
      })
      .where(eq(connectedAccounts.id, row.id));
    console.error("[connections] audit failed", { provider, organizationId, message });
    return lapsed
      ? { ok: false, reason: "needs_reconnect", message: "The connection lapsed. Connect it again." }
      : { ok: false, reason: "unavailable", message: `${adapter.name} couldn't be read just now. Try again later.` };
  }
}

async function sealedUpdate(update: TokenUpdate | undefined) {
  if (!update) return {};
  return {
    ...(update.accessToken !== undefined
      ? { accessTokenSealed: update.accessToken ? await sealToken(update.accessToken) : null }
      : {}),
    ...(update.refreshToken !== undefined
      ? { refreshTokenSealed: update.refreshToken ? await sealToken(update.refreshToken) : null }
      : {}),
    ...(update.expiresAt !== undefined ? { tokenExpiresAt: update.expiresAt } : {}),
  };
}

/** The tenant-scoped way in for the page's "Look now" button. */
export async function runOwnAudit(
  db: Database,
  ctx: TenantContext,
  provider: ConnectionProvider,
  deps: Parameters<typeof runAudit>[3] = {},
): Promise<AuditRun> {
  assertMutable(ctx);
  return runAudit(db, ctx.organizationId, provider, deps);
}

/** One account by its public id, for the page; scoped to the client. */
export async function getConnectedAccount(
  db: Database,
  ctx: TenantContext,
  publicId: string,
): Promise<ConnectedAccountView> {
  const found = (await listConnectedAccounts(db, ctx)).find((a) => a.publicId === publicId);
  if (!found) throw new NotFoundError();
  return found;
}
