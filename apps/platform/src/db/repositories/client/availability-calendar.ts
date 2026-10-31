import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { availabilitySettings, connectedAccounts, type StoredBusyCache } from "@/db/schema";
import { providerAdapter } from "@/lib/connections";
import {
  fetchBusyTimes,
  googleCalendarConfig,
  type GoogleCalendarConfig,
} from "@/lib/connections/providers/google-calendar";
import { ProviderError } from "@/lib/connections/types";
import { APPROVAL_FOR_NEW_SETTINGS } from "@/lib/availability/rules";
import type { Interval } from "@/lib/availability/slots";
import { assertMutable, type TenantContext } from "../context";
import { disconnect, markNeedsReconnect, readLiveConnection, storeTokenUpdate } from "./connections";

/**
 * The client's Google Calendar, as the slot engine needs it: busy times for
 * the bookable window, read at most every few minutes.
 *
 * ## Failing closed
 *
 * A calendar that is connected but cannot be read is not treated as empty.
 * Offering times from weekly hours alone would put customers on top of
 * whatever is in the diary, so the website offers nothing and says booking
 * is unavailable, and the Availability page says why. The last good read is
 * reused only while it is fresh.
 *
 * ## The cache
 *
 * On the client's settings row, not in memory: each serverless instance has
 * its own memory, and a public page can be loaded by many at once. Five
 * minutes keeps Google's quota out of reach of a busy page and still picks
 * up a new event in the calendar before most customers would.
 */

export const BUSY_CACHE_MS = 5 * 60_000;

export type BusyRead =
  | { kind: "none" }
  | { kind: "ok"; busy: Interval[]; checkedAt: Date; email: string | null }
  | {
      kind: "failed";
      reason: "needs_reconnect" | "unavailable" | "not_configured";
      message: string;
      email: string | null;
    };

export interface CalendarDeps {
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Tests pass a configured one; the real one reads the environment. */
  config?: GoogleCalendarConfig;
}

interface CalendarRow {
  id: string;
  status: "connected" | "needs_reconnect" | "revoked";
  displayName: string | null;
  externalId: string;
  connectedAt: Date;
}

async function liveCalendar(db: Database, organizationId: string): Promise<CalendarRow | null> {
  const [row] = await db
    .select({
      id: connectedAccounts.id,
      status: connectedAccounts.status,
      displayName: connectedAccounts.displayName,
      externalId: connectedAccounts.externalId,
      connectedAt: connectedAccounts.connectedAt,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.organizationId, organizationId),
        eq(connectedAccounts.provider, "google_calendar"),
        isNull(connectedAccounts.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

function readCache(raw: StoredBusyCache | null): { from: Date; to: Date; calendarId: string; busy: Interval[] } | null {
  if (!raw || !Array.isArray(raw.busy)) return null;
  const from = new Date(raw.from);
  const to = new Date(raw.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return {
    from,
    to,
    calendarId: raw.calendarId,
    busy: raw.busy
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
      .filter((b) => !Number.isNaN(b.start.getTime()) && !Number.isNaN(b.end.getTime())),
  };
}

/** The settings row's calendar fields, written whether or not the client has saved settings yet. */
async function writeCalendarState(
  db: Database,
  organizationId: string,
  values: Partial<typeof availabilitySettings.$inferInsert>,
  now: Date,
): Promise<void> {
  await db
    .insert(availabilitySettings)
    // Only the insert carries the approval default: the update below must not touch a row that exists.
    .values({ organizationId, requiresApproval: APPROVAL_FOR_NEW_SETTINGS, ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: availabilitySettings.organizationId, set: { ...values, updatedAt: now } });
}

/**
 * Busy times between `from` and `to`. Not tenant-scoped on purpose: the
 * public booking feed has no session. Anything that renders for a client
 * goes through `calendarStatus` below.
 */
export async function readBusyTimes(
  db: Database,
  organizationId: string,
  window: { from: Date; to: Date },
  deps: CalendarDeps = {},
): Promise<BusyRead> {
  const now = deps.now ?? new Date();
  const connection = await liveCalendar(db, organizationId);
  if (!connection) return { kind: "none" };
  const email = connection.displayName;
  if (connection.status === "needs_reconnect") {
    return { kind: "failed", reason: "needs_reconnect", message: "Google Calendar needs connecting again.", email };
  }

  const [settings] = await db
    .select({
      calendarId: availabilitySettings.calendarId,
      busyCache: availabilitySettings.busyCache,
      busyCheckedAt: availabilitySettings.busyCheckedAt,
    })
    .from(availabilitySettings)
    .where(eq(availabilitySettings.organizationId, organizationId))
    .limit(1);
  const calendarId = settings?.calendarId ?? email;
  if (!calendarId) {
    return { kind: "failed", reason: "unavailable", message: "Google did not say which calendar is yours. Connect it again.", email };
  }

  const cached = readCache(settings?.busyCache ?? null);
  const checkedAt = settings?.busyCheckedAt ?? null;
  if (
    cached &&
    checkedAt &&
    now.getTime() - checkedAt.getTime() < BUSY_CACHE_MS &&
    cached.calendarId === calendarId &&
    cached.from.getTime() <= window.from.getTime() &&
    cached.to.getTime() >= window.to.getTime()
  ) {
    return { kind: "ok", busy: cached.busy, checkedAt, email };
  }

  const config = deps.config ?? googleCalendarConfig();
  if (!config.ok) {
    return { kind: "failed", reason: "not_configured", message: "Google Calendar is not switched on here yet.", email };
  }
  const live = await readLiveConnection(db, organizationId, "google_calendar");
  if (!live) return { kind: "none" };

  try {
    const { busy, update } = await fetchBusyTimes(live.tokens, config.config, {
      calendarId,
      from: window.from,
      to: window.to,
      now,
      fetchImpl: deps.fetchImpl,
    });
    await storeTokenUpdate(db, live.id, update, now);
    const cache: StoredBusyCache = {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      calendarId,
      busy: busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
    };
    await writeCalendarState(db, organizationId, { busyCache: cache, busyCheckedAt: now, busyError: null, busyErrorAt: null }, now);
    return { kind: "ok", busy, checkedAt: now, email };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const lapsed = error instanceof ProviderError && error.kind === "auth";
    if (lapsed) await markNeedsReconnect(db, live.id, message, now);
    await writeCalendarState(db, organizationId, { busyError: message.slice(0, 500), busyErrorAt: now }, now);
    console.error("[availability] calendar read failed", { organizationId, lapsed, message });
    return lapsed
      ? { kind: "failed", reason: "needs_reconnect", message: "Google Calendar needs connecting again.", email }
      : { kind: "failed", reason: "unavailable", message: "Google Calendar could not be read just now.", email };
  }
}

export interface CalendarStatus {
  configured: boolean;
  connection: { email: string | null; status: "connected" | "needs_reconnect"; connectedAt: Date } | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** What the Availability page's Google Calendar card shows. */
export async function calendarStatus(db: Database, ctx: TenantContext): Promise<CalendarStatus> {
  const connection = await liveCalendar(db, ctx.organizationId);
  const [settings] = await db
    .select({
      busyCheckedAt: availabilitySettings.busyCheckedAt,
      busyError: availabilitySettings.busyError,
      busyErrorAt: availabilitySettings.busyErrorAt,
    })
    .from(availabilitySettings)
    .where(eq(availabilitySettings.organizationId, ctx.organizationId))
    .limit(1);
  return {
    configured: providerAdapter("google_calendar").configured().ok,
    connection:
      connection && connection.status !== "revoked"
        ? { email: connection.displayName, status: connection.status, connectedAt: connection.connectedAt }
        : null,
    lastCheckedAt: settings?.busyCheckedAt ?? null,
    lastError: settings?.busyError ?? null,
    lastErrorAt: settings?.busyErrorAt ?? null,
  };
}

/**
 * Disconnect the calendar. Google ends every grant this OAuth client holds
 * for a Google account when one token is revoked, so when the same account
 * also connects Search Console here the revoke is skipped — our copy of the
 * access is deleted either way, and Search Console keeps working.
 */
export async function disconnectCalendar(db: Database, ctx: TenantContext, now: Date = new Date()): Promise<boolean> {
  assertMutable(ctx);
  const calendar = await liveCalendar(db, ctx.organizationId);
  if (!calendar) return false;
  const [sharedGrant] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.organizationId, ctx.organizationId),
        isNull(connectedAccounts.revokedAt),
        eq(connectedAccounts.provider, "google"),
        eq(connectedAccounts.externalId, calendar.externalId),
      ),
    )
    .limit(1);
  const adapter = providerAdapter("google_calendar");
  const gone = await disconnect(
    db,
    ctx,
    "google_calendar",
    sharedGrant ? { adapter: { ...adapter, revoke: async () => {} } } : {},
    now,
  );
  await writeCalendarState(
    db,
    ctx.organizationId,
    { busyCache: null, busyCheckedAt: null, busyError: null, busyErrorAt: null },
    now,
  );
  return gone;
}
