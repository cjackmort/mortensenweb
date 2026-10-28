import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Database } from "@/db/client";
import { connectedAccounts, searchSnapshots, sites } from "@/db/schema";
import {
  fetchSearchSnapshot,
  googleSearchConfig,
  type SearchSnapshot,
} from "@/lib/connections/providers/google";
import { hostOf, ProviderError } from "@/lib/connections/types";
import { assertMutable, type TenantContext } from "../context";
import { markNeedsReconnect, readLiveConnection, storeTokenUpdate } from "./connections";

/**
 * Daily Search Console snapshots, and what the Search page makes of them.
 *
 * Taking one is the only place the Google tokens are used outside the
 * audit. Reading is tenant-scoped and never calls Google: the page shows
 * what was stored, says how old it is, and says plainly when the last
 * attempt failed — a failed fetch must never look like a quiet month.
 */

/** A failed day is tried again after this, not every tick. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** How many days of snapshots the page reads for the day-to-day trend. */
export const TREND_DAYS = 28;

export function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type SnapshotFetcher = (
  tokens: Parameters<typeof fetchSearchSnapshot>[0],
  config: Parameters<typeof fetchSearchSnapshot>[1],
  context: Parameters<typeof fetchSearchSnapshot>[2],
) => ReturnType<typeof fetchSearchSnapshot>;

export type TakeResult =
  | { ok: true; snapshot: SearchSnapshot }
  | { ok: false; reason: "not_connected" | "needs_reconnect" | "no_site" | "not_configured" | "failed"; message: string };

/** The organization's site: the first one is the business's, as the audit reads it too. */
async function siteFor(db: Database, organizationId: string): Promise<{ id: string; host: string | null } | null> {
  const [site] = await db
    .select({ id: sites.id, primaryDomain: sites.primaryDomain })
    .from(sites)
    .where(eq(sites.organizationId, organizationId))
    .orderBy(asc(sites.createdAt))
    .limit(1);
  return site ? { id: site.id, host: hostOf(site.primaryDomain) } : null;
}

/**
 * Take today's snapshot for one client and keep it.
 *
 * Writes the day's row whatever happens: the figures on success, the error
 * otherwise, so the page can say which. A lapsed grant also marks the
 * connection, so the Connections page offers Connect again.
 */
export async function takeSearchSnapshot(
  db: Database,
  organizationId: string,
  deps: { now?: Date; fetchImpl?: typeof fetch; fetchSnapshot?: SnapshotFetcher; env?: Record<string, string | undefined> } = {},
): Promise<TakeResult> {
  const now = deps.now ?? new Date();
  const connection = await readLiveConnection(db, organizationId, "google");
  if (!connection) return { ok: false, reason: "not_connected", message: "Google is not connected." };
  if (connection.status !== "connected") {
    return { ok: false, reason: "needs_reconnect", message: "The Google connection lapsed. Connect it again." };
  }
  const site = await siteFor(db, organizationId);
  if (!site) return { ok: false, reason: "no_site", message: "No website to look up." };

  const config = googleSearchConfig(deps.env);
  if (!config.ok) {
    const message = `Google is not set up on the server (${config.missing.join(", ")}).`;
    await writeFailure(db, organizationId, site.id, now, message);
    return { ok: false, reason: "not_configured", message };
  }

  try {
    const fetchSnapshot = deps.fetchSnapshot ?? fetchSearchSnapshot;
    const { snapshot, update } = await fetchSnapshot(connection.tokens, config.config, {
      siteHost: site.host,
      now,
      fetchImpl: deps.fetchImpl,
    });
    await storeTokenUpdate(db, connection.id, update, now);
    await db
      .insert(searchSnapshots)
      .values({
        organizationId,
        siteId: site.id,
        takenOn: dayOf(now),
        property: snapshot.property,
        data: snapshot,
        error: null,
        attemptedAt: now,
        fetchedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [searchSnapshots.siteId, searchSnapshots.takenOn],
        set: { property: snapshot.property, data: snapshot, error: null, attemptedAt: now, fetchedAt: now, updatedAt: now },
      });
    return { ok: true, snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const lapsed = error instanceof ProviderError && error.kind === "auth";
    if (lapsed) await markNeedsReconnect(db, connection.id, message, now);
    await writeFailure(db, organizationId, site.id, now, message);
    console.error("[search] snapshot failed", { organizationId, message });
    return lapsed
      ? { ok: false, reason: "needs_reconnect", message: "The Google connection lapsed. Connect it again." }
      : { ok: false, reason: "failed", message: "Google Search Console couldn't be read just now." };
  }
}

/** A failed day keeps its row, with the error and no figures; a later success replaces it. */
async function writeFailure(db: Database, organizationId: string, siteId: string, now: Date, message: string): Promise<void> {
  const error = message.slice(0, 500);
  const today = and(eq(searchSnapshots.siteId, siteId), eq(searchSnapshots.takenOn, dayOf(now)));
  const [existing] = await db.select({ data: searchSnapshots.data }).from(searchSnapshots).where(today).limit(1);
  // A good snapshot taken earlier today stays; only the attempt is noted.
  if (existing?.data) {
    await db.update(searchSnapshots).set({ attemptedAt: now, updatedAt: now }).where(today);
    return;
  }
  await db
    .insert(searchSnapshots)
    .values({ organizationId, siteId, takenOn: dayOf(now), data: null, error, attemptedAt: now, fetchedAt: null, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [searchSnapshots.siteId, searchSnapshots.takenOn],
      set: { error, attemptedAt: now, updatedAt: now },
    });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SearchTrendPoint {
  takenOn: string;
  clicks: number;
  impressions: number;
  position: number;
}

export type SearchView =
  /** No live Google connection: the page says to connect first. */
  | { state: "not_connected" }
  /** The grant lapsed: reconnect. */
  | { state: "needs_reconnect"; connectedAs: string | null }
  /** Connected, nothing fetched yet, no failure recorded either. */
  | { state: "pending"; connectedAs: string | null }
  /** Connected, every attempt so far has failed. */
  | { state: "failed"; connectedAs: string | null; error: string; attemptedAt: Date }
  | {
      state: "ready";
      connectedAs: string | null;
      snapshot: SearchSnapshot;
      fetchedAt: Date;
      /** The most recent attempt failed and these figures are older than today. */
      staleError: { error: string; attemptedAt: Date } | null;
      /** One point per stored day, oldest first — how the 28-day totals moved. */
      trend: SearchTrendPoint[];
    };

export async function getSearchView(db: Database, ctx: TenantContext, deps: { now?: Date } = {}): Promise<SearchView> {
  const now = deps.now ?? new Date();
  const [connection] = await db
    .select({ status: connectedAccounts.status, displayName: connectedAccounts.displayName })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.organizationId, ctx.organizationId), eq(connectedAccounts.provider, "google")))
    .orderBy(desc(connectedAccounts.connectedAt))
    .limit(1);
  const live = connection && connection.status !== "revoked" ? connection : null;
  if (!live) return { state: "not_connected" };
  const connectedAs = live.displayName;
  if (live.status === "needs_reconnect") return { state: "needs_reconnect", connectedAs };

  const since = new Date(now.getTime() - TREND_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      takenOn: searchSnapshots.takenOn,
      data: searchSnapshots.data,
      error: searchSnapshots.error,
      attemptedAt: searchSnapshots.attemptedAt,
      fetchedAt: searchSnapshots.fetchedAt,
    })
    .from(searchSnapshots)
    .where(and(eq(searchSnapshots.organizationId, ctx.organizationId), gte(searchSnapshots.takenOn, dayOf(since))))
    .orderBy(asc(searchSnapshots.takenOn));

  const fetched = rows.filter((r) => r.data && r.fetchedAt);
  const latest = fetched[fetched.length - 1];
  const newest = rows[rows.length - 1];

  if (!latest) {
    if (newest?.error) return { state: "failed", connectedAs, error: newest.error, attemptedAt: newest.attemptedAt };
    return { state: "pending", connectedAs };
  }

  const snapshot = latest.data as SearchSnapshot;
  const staleError =
    newest && newest !== latest && newest.error ? { error: newest.error, attemptedAt: newest.attemptedAt } : null;
  const trend: SearchTrendPoint[] = fetched.map((r) => {
    const d = r.data as SearchSnapshot;
    return { takenOn: r.takenOn, clicks: d.totals.clicks, impressions: d.totals.impressions, position: d.totals.position };
  });
  return { state: "ready", connectedAs, snapshot, fetchedAt: latest.fetchedAt!, staleError, trend };
}

/** The tenant-scoped way in for the page's "Try again now" button. */
export async function takeOwnSearchSnapshot(
  db: Database,
  ctx: TenantContext,
  deps: Parameters<typeof takeSearchSnapshot>[2] = {},
): Promise<TakeResult> {
  assertMutable(ctx);
  return takeSearchSnapshot(db, ctx.organizationId, deps);
}
