import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appointmentBookings,
  availabilityDateOverrides,
  availabilitySettings,
  availabilityWeeklyHours,
  clients,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import {
  DEFAULT_RULES,
  parseOverride,
  parseRules,
  parseWeeklyHours,
  readStoredRanges,
  type AvailabilityRules,
} from "@/lib/availability/rules";
import {
  bookableWindow,
  emptyWeek,
  openSlots,
  type DateOverride,
  type FullWeek,
  type Interval,
  type Slot,
  type SlotInput,
  type TimeRange,
} from "@/lib/availability/slots";
import { addDays, dateInZone, zonedTimeToInstant, type IsoDate } from "@/lib/availability/time";
import { assertMutable, NotFoundError, type TenantContext } from "../context";
import { readBusyTimes, type BusyRead, type CalendarDeps } from "./availability-calendar";

/**
 * A client's availability: their booking rules, weekly hours and days off,
 * tenant-scoped.
 *
 * Opened by `clients.booking_enabled`. The page and every action gate on
 * `bookingAccess` themselves; the tab in the nav decides only what is shown.
 */

export type AvailabilityResult = { ok: true; message: string } | { ok: false; message: string };

export interface BookingAccess {
  /** May use the Availability page. */
  allowed: boolean;
  /** `clients.booking_enabled`: the website takes bookings. */
  bookingEnabled: boolean;
  /** The agency's own account, which may try the page without it. */
  internal: boolean;
}

export async function bookingAccess(db: Database, ctx: TenantContext): Promise<BookingAccess> {
  const [row] = await db
    .select({ bookingEnabled: clients.bookingEnabled, isInternal: clients.isInternal })
    .from(clients)
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);
  if (!row) return { allowed: false, bookingEnabled: false, internal: false };
  return { allowed: row.bookingEnabled || row.isInternal, bookingEnabled: row.bookingEnabled, internal: row.isInternal };
}

/**
 * True once the client has given any weekly hours. The Get started checklist
 * calls it: until then the website's booking page offers nothing.
 */
export async function isAvailabilitySetUp(db: Database, ctx: TenantContext): Promise<boolean> {
  const [row] = await db
    .select({ id: availabilityWeeklyHours.id })
    .from(availabilityWeeklyHours)
    .where(
      and(
        eq(availabilityWeeklyHours.organizationId, ctx.organizationId),
        sql`jsonb_array_length(${availabilityWeeklyHours.ranges}) > 0`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OverrideView {
  publicId: string;
  date: IsoDate;
  /** Empty: closed all day. */
  ranges: TimeRange[];
}

export interface AvailabilityView {
  rules: AvailabilityRules;
  /** False until the client first saves the booking rules: the page shows the defaults. */
  rulesSaved: boolean;
  weekly: FullWeek;
  /** Today onwards, soonest first. */
  overrides: OverrideView[];
  today: IsoDate;
}

async function readRules(db: Database, organizationId: string): Promise<{ rules: AvailabilityRules; saved: boolean }> {
  const [row] = await db
    .select()
    .from(availabilitySettings)
    .where(eq(availabilitySettings.organizationId, organizationId))
    .limit(1);
  if (!row) return { rules: DEFAULT_RULES, saved: false };
  return {
    rules: {
      timeZone: row.timeZone,
      slotMinutes: row.slotMinutes,
      bufferMinutes: row.bufferMinutes,
      minNoticeMinutes: row.minNoticeMinutes,
      horizonDays: row.horizonDays,
      requiresApproval: row.requiresApproval,
    },
    // A row made only to hold the calendar cache has never been saved by the client.
    saved: row.updatedBy !== null,
  };
}

async function readWeekly(db: Database, organizationId: string): Promise<FullWeek> {
  const rows = await db
    .select({ weekday: availabilityWeeklyHours.weekday, ranges: availabilityWeeklyHours.ranges })
    .from(availabilityWeeklyHours)
    .where(eq(availabilityWeeklyHours.organizationId, organizationId));
  const week: FullWeek = emptyWeek();
  for (const row of rows) {
    if (row.weekday >= 0 && row.weekday <= 6) week[row.weekday as keyof FullWeek] = readStoredRanges(row.ranges);
  }
  return week;
}

async function readOverrides(db: Database, organizationId: string, from: IsoDate): Promise<OverrideView[]> {
  const rows = await db
    .select({
      publicId: availabilityDateOverrides.publicId,
      date: availabilityDateOverrides.date,
      ranges: availabilityDateOverrides.ranges,
    })
    .from(availabilityDateOverrides)
    .where(and(eq(availabilityDateOverrides.organizationId, organizationId), gte(availabilityDateOverrides.date, from)))
    .orderBy(asc(availabilityDateOverrides.date));
  return rows.map((r) => ({ publicId: r.publicId, date: r.date, ranges: readStoredRanges(r.ranges) }));
}

export async function getAvailability(db: Database, ctx: TenantContext, now: Date = new Date()): Promise<AvailabilityView> {
  const { rules, saved } = await readRules(db, ctx.organizationId);
  const today = dateInZone(now, rules.timeZone);
  const [weekly, overrides] = await Promise.all([
    readWeekly(db, ctx.organizationId),
    readOverrides(db, ctx.organizationId, today),
  ]);
  return { rules, rulesSaved: saved, weekly, overrides, today };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function saveRules(
  db: Database,
  ctx: TenantContext,
  form: Parameters<typeof parseRules>[0],
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  assertMutable(ctx);
  const parsed = parseRules(form);
  if (!parsed.ok) return parsed;
  const values = { ...parsed.value, updatedBy: ctx.userId, updatedAt: now };
  await db
    .insert(availabilitySettings)
    .values({ organizationId: ctx.organizationId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: availabilitySettings.organizationId, set: values });
  return {
    ok: true,
    message: parsed.value.requiresApproval
      ? "Saved. New bookings wait for you to approve them."
      : "Saved. Open times are confirmed as soon as they're booked.",
  };
}

/**
 * Replace the whole week in one statement: all seven days are written
 * together, so a failure leaves the old week, never half of each.
 */
export async function saveWeeklyHours(
  db: Database,
  ctx: TenantContext,
  raw: unknown,
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  assertMutable(ctx);
  const parsed = parseWeeklyHours(raw);
  if (!parsed.ok) return parsed;
  const rows = Object.entries(parsed.value).map(([weekday, ranges]) => ({
    organizationId: ctx.organizationId,
    weekday: Number(weekday),
    ranges,
    updatedAt: now,
  }));
  await db
    .insert(availabilityWeeklyHours)
    .values(rows)
    .onConflictDoUpdate({
      target: [availabilityWeeklyHours.organizationId, availabilityWeeklyHours.weekday],
      set: { ranges: sql`excluded.ranges`, updatedAt: now },
    });
  const open = rows.filter((r) => r.ranges.length > 0).length;
  return {
    ok: true,
    message: open === 0 ? "Saved. Every day is closed, so your website offers no times." : "Saved your weekly hours.",
  };
}

/** A date closed, or with its own hours. Saving a date again replaces what it had. */
export async function saveDateOverride(
  db: Database,
  ctx: TenantContext,
  form: Parameters<typeof parseOverride>[0],
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  assertMutable(ctx);
  const { rules } = await readRules(db, ctx.organizationId);
  const parsed = parseOverride(form, dateInZone(now, rules.timeZone));
  if (!parsed.ok) return parsed;
  await db
    .insert(availabilityDateOverrides)
    .values({
      publicId: newPublicId(),
      organizationId: ctx.organizationId,
      date: parsed.value.date,
      ranges: parsed.value.ranges,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [availabilityDateOverrides.organizationId, availabilityDateOverrides.date],
      set: { ranges: parsed.value.ranges, createdBy: ctx.userId, updatedAt: now },
    });
  return {
    ok: true,
    message: parsed.value.ranges.length === 0 ? "Saved. That day is closed." : "Saved. That day has its own hours.",
  };
}

export async function removeDateOverride(db: Database, ctx: TenantContext, publicId: string): Promise<AvailabilityResult> {
  assertMutable(ctx);
  const removed = await db
    .delete(availabilityDateOverrides)
    .where(
      and(eq(availabilityDateOverrides.publicId, publicId), eq(availabilityDateOverrides.organizationId, ctx.organizationId)),
    )
    .returning({ id: availabilityDateOverrides.id });
  if (removed.length === 0) throw new NotFoundError();
  return { ok: true, message: "Removed. That day follows your weekly hours again." };
}

// ---------------------------------------------------------------------------
// The slot engine's inputs
// ---------------------------------------------------------------------------

export interface LoadedSlots {
  rules: AvailabilityRules;
  /** Everything but the window, ready for `openSlots`. */
  input: SlotInput;
  calendar: BusyRead;
  /** Any weekly hours at all. */
  open: boolean;
  window: { first: IsoDate; last: IsoDate };
}

/** Pending and confirmed bookings still to come: both hold their time. */
async function heldTimes(db: Database, organizationId: string, now: Date): Promise<Interval[]> {
  const rows = await db
    .select({ start: appointmentBookings.startsAt, end: appointmentBookings.endsAt })
    .from(appointmentBookings)
    .where(
      and(
        eq(appointmentBookings.organizationId, organizationId),
        inArray(appointmentBookings.status, ["pending", "confirmed"]),
        // A day back covers any buffer reaching forward from a booking that has ended.
        gt(appointmentBookings.endsAt, new Date(now.getTime() - 86_400_000)),
      ),
    );
  return rows;
}

/**
 * Everything the slot engine needs for a client, read fresh. Not
 * tenant-scoped on purpose: the public booking feed and the booking re-check
 * have no session. Anything that renders for a client goes through the
 * scoped functions above and `previewSlots`.
 */
export async function loadSlotInput(
  db: Database,
  organizationId: string,
  deps: CalendarDeps = {},
): Promise<LoadedSlots> {
  const now = deps.now ?? new Date();
  const { rules } = await readRules(db, organizationId);
  const window = bookableWindow(rules, now);
  const [weekly, overrides, booked] = await Promise.all([
    readWeekly(db, organizationId),
    readOverrides(db, organizationId, window.first),
    heldTimes(db, organizationId, now),
  ]);
  const windowEnd = zonedTimeToInstant(addDays(window.last, 1), 0, rules.timeZone);
  const calendar = await readBusyTimes(db, organizationId, { from: now, to: windowEnd }, { ...deps, now });
  const asOverrides: DateOverride[] = overrides.map((o) => ({ date: o.date, ranges: o.ranges }));

  return {
    rules,
    input: {
      ...rules,
      weekly,
      overrides: asOverrides,
      busy: calendar.kind === "ok" ? calendar.busy : [],
      booked,
      now,
    },
    calendar,
    open: Object.values(weekly).some((ranges) => ranges.length > 0),
    window,
  };
}

export interface SlotPreview {
  rules: AvailabilityRules;
  calendar: BusyRead;
  open: boolean;
  /** Null when the calendar could not be read: the website offers nothing then either. */
  slots: Slot[] | null;
}

/** The next open times exactly as the website would show them now. */
export async function previewSlots(db: Database, ctx: TenantContext, deps: CalendarDeps = {}): Promise<SlotPreview> {
  const loaded = await loadSlotInput(db, ctx.organizationId, deps);
  return {
    rules: loaded.rules,
    calendar: loaded.calendar,
    open: loaded.open,
    slots: loaded.calendar.kind === "failed" ? null : openSlots(loaded.input),
  };
}
