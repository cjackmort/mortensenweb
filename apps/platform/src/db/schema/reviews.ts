import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { leads } from "./growth";

/**
 * Review requests: a client asks a customer for a Google review, and the
 * portal sends one reminder if the link goes unclicked. See `lib/reviews/`.
 *
 * In its own file rather than appended to `growth.ts`, so the Growth features
 * being built side by side touch different files.
 *
 * There is deliberately nothing here that records how a customer felt. Google
 * forbids asking only happy customers for reviews ("review gating"), so every
 * request carries the Google link and nothing filters who gets it.
 */

/**
 * One business's review setup: where the link goes and what the message says.
 *
 * `reviewUrl` is the Google "write a review" link, built from `placeId` when
 * there is one. A `g.page/r/…/review` short link from the client's own Google
 * Business Profile is accepted too, and has no place id to keep.
 *
 * The template columns are null until the client edits them, and null means
 * "the portal's default". That way a better default reaches every business
 * that never changed theirs, instead of being frozen at whatever it was the
 * day they set up.
 */
export const reviewSettings = pgTable(
  "review_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewUrl: text("review_url").notNull(),
    placeId: text("place_id"),
    /** The business as Google lists it, when the Places API confirmed the id. */
    placeName: text("place_name"),
    emailSubject: text("email_subject"),
    emailBody: text("email_body"),
    reminderBody: text("reminder_body"),
    reminderDays: integer("reminder_days").notNull().default(3),
    remindersEnabled: boolean("reminders_enabled").notNull().default(true),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_settings_org_key").on(t.organizationId),
    check("review_settings_reminder_days_range", sql`${t.reminderDays} BETWEEN 1 AND 14`),
  ],
);

/**
 * One customer asked for a review.
 *
 * The send is recorded per channel (`emailStatus`, `smsStatus`; null means
 * that channel was not used), whatever happened to it: a request that failed
 * must still show on the list, or the client would believe the customer had
 * been asked.
 *
 * ## One reminder, structurally
 *
 * There is one `remindedAt` and nowhere to record a second. The scheduler
 * claims a reminder by setting it in a conditional update before sending, so
 * two overlapping runs cannot both send, and a run that dies mid-send leaves
 * the request reminded rather than eligible again. Fewer emails is the
 * direction to fail in.
 *
 * ## SMS consent
 *
 * The TCPA needs a customer's consent before a business texts them, so a text
 * is only ever recorded against a request that also records who confirmed that
 * consent and when. A check constraint holds the table to it: an `smsStatus`
 * without `smsConsentAt` cannot be written.
 *
 * `email` is stored lowercased and `phone` in E.164, so the suppression check
 * and the "already asked recently" check compare like with like.
 */
export const reviewRequests = pgTable(
  "review_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The enquiry they came from, when the client picked one from the leads inbox. */
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    customerName: text("customer_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    smsConsentBy: uuid("sms_consent_by").references(() => users.id, { onDelete: "set null" }),

    /** Who it came from and where answers go, as sent — the reminder reuses both. */
    fromName: text("from_name").notNull(),
    replyTo: text("reply_to"),

    emailStatus: text("email_status"),
    smsStatus: text("sms_status"),
    /** The first time any channel reached its provider. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** When the reminder becomes due. Null when no reminder will be sent. */
    reminderDueAt: timestamp("reminder_due_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    reminderStatus: text("reminder_status"),

    firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
    lastClickedAt: timestamp("last_clicked_at", { withTimezone: true }),
    clickCount: integer("click_count").notNull().default(0),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),

    /** The last provider error, trimmed. Never shown to the customer. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_requests_public_id_key").on(t.publicId),
    index("review_requests_org_created_idx").on(t.organizationId, t.createdAt),
    index("review_requests_org_email_idx").on(t.organizationId, t.email),
    index("review_requests_org_phone_idx").on(t.organizationId, t.phone),
    // What the scheduler scans for, and nothing else.
    index("review_requests_reminder_due_idx")
      .on(t.reminderDueAt)
      .where(
        sql`${t.reminderDueAt} IS NOT NULL AND ${t.remindedAt} IS NULL AND ${t.firstClickedAt} IS NULL`,
      ),
    check("review_requests_has_recipient", sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`),
    check("review_requests_sms_needs_consent", sql`${t.smsStatus} IS NULL OR ${t.smsConsentAt} IS NOT NULL`),
    check(
      "review_requests_email_status_known",
      sql`${t.emailStatus} IS NULL OR ${t.emailStatus} IN ('sent', 'failed', 'not_sent', 'suppressed')`,
    ),
    check(
      "review_requests_sms_status_known",
      sql`${t.smsStatus} IS NULL OR ${t.smsStatus} IN ('sent', 'failed', 'not_sent', 'suppressed')`,
    ),
    check(
      "review_requests_reminder_status_known",
      sql`${t.reminderStatus} IS NULL OR ${t.reminderStatus} IN ('sending', 'sent', 'failed', 'not_sent', 'suppressed')`,
    ),
    check(
      "review_requests_reminder_claimed",
      sql`(${t.remindedAt} IS NULL) = (${t.reminderStatus} IS NULL)`,
    ),
    check("review_requests_click_count_positive", sql`${t.clickCount} >= 0`),
  ],
);

/**
 * People a business must not ask again, per channel.
 *
 * Checked before every send — the request and its reminder alike — so someone
 * who unsubscribes from the first email does not get the reminder three days
 * later. Per business: unsubscribing from one client's requests says nothing
 * about another's.
 *
 * `reason` is how they got here: `unsubscribed` (the link in an email),
 * `sms_opt_out` (replied STOP, reported by the SMS provider), or `manual` (the
 * client said not to ask them). Only `manual` entries can be removed by the
 * client; the other two are the customer's decision.
 */
export const reviewSuppressions = pgTable(
  "review_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    /** Lowercased email, or an E.164 phone number. */
    address: text("address").notNull(),
    reason: text("reason").notNull(),
    requestId: uuid("request_id").references(() => reviewRequests.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_suppressions_org_address_key").on(t.organizationId, t.channel, t.address),
    check("review_suppressions_channel_known", sql`${t.channel} IN ('email', 'sms')`),
    check(
      "review_suppressions_reason_known",
      sql`${t.reason} IN ('unsubscribed', 'sms_opt_out', 'manual')`,
    ),
  ],
);
