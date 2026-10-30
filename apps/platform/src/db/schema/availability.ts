import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { sites } from "./sites";

/**
 * Availability: the times a client's customers can book on the website.
 *
 * Opened by `clients.booking_enabled`. The client sets weekly hours, the
 * rules a slot follows, and days off; the portal subtracts their Google
 * Calendar's busy times and what is already booked, and the site's book page
 * shows what is left (`lib/availability/slots.ts`).
 *
 * Hours are stored as the client says them — a weekday and minutes after
 * local midnight, in the client's timezone — never as instants: "Mondays 9 to
 * 5" must still mean 9 to 5 after the clocks change.
 */

/** `{ start, end }`, minutes after local midnight; `end` may be 1440. */
export interface StoredRange {
  start: number;
  end: number;
}

/** Google Calendar's busy times as last read, kept for a few minutes. */
export interface StoredBusyCache {
  /** The window that was asked about, ISO. */
  from: string;
  to: string;
  calendarId: string;
  busy: Array<{ start: string; end: string }>;
}

/** One row per client, made the first time they save anything. */
export const availabilitySettings = pgTable(
  "availability_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** IANA name. Every slot is drawn in this zone, whatever the visitor's. */
    timeZone: text("time_zone").notNull().default("America/Denver"),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    /** Clear time kept around anything already in the diary. */
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    /** Nothing is offered sooner than this from now. */
    minNoticeMinutes: integer("min_notice_minutes").notNull().default(120),
    /** How many days ahead, today included, the website offers times. */
    horizonDays: integer("horizon_days").notNull().default(30),
    /**
     * On: a booking holds its slot as `pending` until the client approves or
     * declines it. Off: an open slot is confirmed the moment it is booked.
     */
    requiresApproval: boolean("requires_approval").notNull().default(false),
    /**
     * The Google calendar whose busy times are subtracted. Null is the
     * connected account's primary calendar, the only one the free/busy scope
     * can name without listing calendars.
     */
    calendarId: text("calendar_id"),
    busyCache: jsonb("busy_cache").$type<StoredBusyCache>(),
    busyCheckedAt: timestamp("busy_checked_at", { withTimezone: true }),
    /** The last failed read, cleared by the next good one. Shown on the page. */
    busyError: text("busy_error"),
    busyErrorAt: timestamp("busy_error_at", { withTimezone: true }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("availability_settings_org_key").on(t.organizationId),
    check("availability_settings_slot_range", sql`${t.slotMinutes} BETWEEN 5 AND 480`),
    check("availability_settings_buffer_range", sql`${t.bufferMinutes} BETWEEN 0 AND 240`),
    check("availability_settings_notice_range", sql`${t.minNoticeMinutes} BETWEEN 0 AND 43200`),
    check("availability_settings_horizon_range", sql`${t.horizonDays} BETWEEN 1 AND 90`),
    check(
      "availability_settings_busy_cache_object",
      sql`${t.busyCache} IS NULL OR jsonb_typeof(${t.busyCache}) = 'object'`,
    ),
  ],
);

/** A client's hours for one weekday: several ranges, or none for closed. */
export const availabilityWeeklyHours = pgTable(
  "availability_weekly_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0 is Sunday. */
    weekday: integer("weekday").notNull(),
    ranges: jsonb("ranges").$type<StoredRange[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("availability_weekly_hours_day_key").on(t.organizationId, t.weekday),
    check("availability_weekly_hours_weekday", sql`${t.weekday} BETWEEN 0 AND 6`),
    check("availability_weekly_hours_ranges_array", sql`jsonb_typeof(${t.ranges}) = 'array'`),
  ],
);

/** One date's own hours: closed all day (no ranges), or different hours. */
export const availabilityDateOverrides = pgTable(
  "availability_date_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The business's calendar date. */
    date: date("date", { mode: "string" }).notNull(),
    ranges: jsonb("ranges").$type<StoredRange[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("availability_date_overrides_public_id_key").on(t.publicId),
    uniqueIndex("availability_date_overrides_day_key").on(t.organizationId, t.date),
    check("availability_date_overrides_ranges_array", sql`jsonb_typeof(${t.ranges}) = 'array'`),
  ],
);

export const APPOINTMENT_STATUSES = ["pending", "confirmed", "declined", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_EMAIL_STATUSES = ["sent", "failed", "not_sent"] as const;
export type AppointmentEmailStatus = (typeof APPOINTMENT_EMAIL_STATUSES)[number];

/**
 * A time a customer booked on the website.
 *
 * `pending` and `confirmed` hold the slot; `declined` and `cancelled` give it
 * back. That rule is enforced here, not only in code: at most one held
 * booking per client per start instant (`appointment_bookings_held_slot_key`),
 * so two visitors pressing "Book" on the same slot at the same moment cannot
 * both get it — the second insert fails however the requests interleave.
 *
 * The slot belongs to the client, not the site: a client with two sites has
 * one diary. `site_id` records which site it came from.
 *
 * `customer_email_status` is what happened to the last email the customer was
 * sent about it (confirmed, declined, cancelled), and `client_email_status`
 * to the notice the client was sent when it arrived — recorded either way, so
 * the page never implies someone was told when they were not.
 */
export const appointmentBookings = pgTable(
  "appointment_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** The zone the time was offered in, so emails say it the way the customer saw it. */
    timeZone: text("time_zone").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone"),
    note: text("note"),
    status: text("status").$type<AppointmentStatus>().notNull(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    customerEmailStatus: text("customer_email_status").$type<AppointmentEmailStatus>(),
    customerEmailError: text("customer_email_error"),
    clientEmailStatus: text("client_email_status").$type<AppointmentEmailStatus>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("appointment_bookings_public_id_key").on(t.publicId),
    uniqueIndex("appointment_bookings_held_slot_key")
      .on(t.organizationId, t.startsAt)
      .where(sql`${t.status} IN ('pending', 'confirmed')`),
    index("appointment_bookings_org_starts_idx").on(t.organizationId, t.startsAt),
    check("appointment_bookings_order", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "appointment_bookings_status_known",
      sql`${t.status} IN ('pending', 'confirmed', 'declined', 'cancelled')`,
    ),
    check(
      "appointment_bookings_customer_email_status_known",
      sql`${t.customerEmailStatus} IS NULL OR ${t.customerEmailStatus} IN ('sent', 'failed', 'not_sent')`,
    ),
    check(
      "appointment_bookings_client_email_status_known",
      sql`${t.clientEmailStatus} IS NULL OR ${t.clientEmailStatus} IN ('sent', 'failed', 'not_sent')`,
    ),
  ],
);
