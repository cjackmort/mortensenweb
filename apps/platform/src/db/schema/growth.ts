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
import { clients } from "./clients";
import { leadStatusEnum } from "./enums";

/**
 * Growth: what a live site brings in. See `docs/growth-plan.md`.
 */

/**
 * One contact-form submission from a client's site.
 *
 * Netlify Forms is the system of record for *capture* — it accepts the
 * submission even while the portal is down, and filters spam — and this is the
 * client's working copy: the thing they read, mark contacted, and close.
 *
 * `name`, `email`, `phone` and `message` are pulled out of the submitted
 * fields by common names so the inbox can show a one-line summary; `fields`
 * keeps every field exactly as submitted, in form order, so a form with a
 * "Which service?" dropdown loses nothing to the extraction.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),

    /** The form backend, and its own id for the submission: the dedupe key. */
    provider: text("provider").notNull().default("netlify"),
    providerSubmissionId: text("provider_submission_id").notNull(),
    formName: text("form_name"),

    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    message: text("message"),
    /** `[{ label, value }]`, in the order the form presented them. */
    fields: jsonb("fields").notNull().default(sql`'[]'::jsonb`),
    /** The page the form was sent from, when the backend recorded it. */
    pageUrl: text("page_url"),

    status: leadStatusEnum("status").notNull().default("new"),
    /** When the backend received it — not when we did, which can be hours later on a backfill. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** First opened by anyone in the client's organization. Drives the unread count. */
    readAt: timestamp("read_at", { withTimezone: true }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    /**
     * Moved out of the inbox, by the client or by the trim that keeps the
     * newest ten. Kept apart from `status` so archiving never changes what the
     * client marked it: a won job that leaves the inbox is still won, and still
     * counted as won. Null is in the inbox.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * Unused since the portal stopped emailing about new leads — Netlify's own
     * form notification does that. Kept rather than dropped: removing a column
     * is a migration with no benefit, and it would be the place to record a
     * portal notification if one ever comes back.
     */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /**
     * Deleted by the client. The row stays, emptied of everything personal,
     * as a tombstone: Netlify still holds the submission, and without the
     * row the next backfill would import it again — a deleted customer
     * reappearing in the inbox is the one thing deleting has to prevent.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("leads_public_id_key").on(t.publicId),
    uniqueIndex("leads_provider_submission_key").on(
      t.provider,
      t.providerSubmissionId,
    ),
    index("leads_org_received_idx").on(t.organizationId, t.receivedAt),
    index("leads_org_status_idx").on(t.organizationId, t.status),
    check("leads_fields_array", sql`jsonb_typeof(${t.fields}) = 'array'`),
  ],
);

/**
 * A reply the client sent to a lead from the portal.
 *
 * Sent through Resend from the portal's own domain under the business's name,
 * with the client's address as reply-to — so the customer's answer lands in
 * the client's normal inbox, and the client gets a copy of what was sent.
 * Nothing here needs the client's mailbox; see `lib/growth/lead-reply.ts`.
 *
 * `status` is what happened to the send, recorded either way: a reply that
 * failed must still be visible on the enquiry, or a client would believe the
 * customer had been answered.
 */
export const leadReplies = pgTable(
  "lead_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    /** Where the customer's answer goes. Recorded, because it can change later. */
    replyTo: text("reply_to").notNull(),
    /** `sent`, `failed`, or `not_sent` (no mail provider configured here). */
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_replies_public_id_key").on(t.publicId),
    index("lead_replies_lead_idx").on(t.leadId, t.createdAt),
    index("lead_replies_org_created_idx").on(t.organizationId, t.createdAt),
    check(
      "lead_replies_status_known",
      sql`${t.status} IN ('sent', 'failed', 'not_sent')`,
    ),
  ],
);

/**
 * A client's decision on a performer's booking request, and — once approved —
 * one entry on that site's upcoming events.
 *
 * A booking request arrives as an ordinary lead from the site's booking form
 * (see `lib/growth/bookings.ts`); this row is what the client decided about
 * it. One per lead, so approving twice cannot list a band twice or email them
 * twice. Declines are rows too, so the inbox can say "you declined this" and
 * the client can still change their mind.
 *
 * The act's name, genre, date and logo are copied here at approval rather than
 * read through the lead: the lead is the customer's private message and can be
 * deleted, while this is what the client chose to publish.
 *
 * `email_status` is what happened to the "you're booked" email, recorded
 * either way — a client must be able to see that a band was *not* told.
 */
export const eventBookings = pgTable(
  "event_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),

    /**
     * `held` (saved to the client's calendar, not on the site, nobody
     * emailed), `approved`, or `declined`.
     */
    decision: text("decision").notNull(),
    actName: text("act_name").notNull(),
    genre: text("genre"),
    /** The day they play, as the business means it — a calendar date, not an instant. */
    eventDate: date("event_date", { mode: "string" }),
    /** `HH:MM`, 24-hour, in the business's timezone. Optional. */
    startTime: text("start_time"),
    isTicketed: boolean("is_ticketed").notNull().default(false),
    /** In the `event-logos` store, copied from the form upload at approval. */
    logoKey: text("logo_key"),
    /** Sniffed from the bytes when stored, never taken from the upload's claim. */
    logoContentType: text("logo_content_type"),
    /** Where "you're booked" went. Erased with the lead. */
    contactEmail: text("contact_email"),

    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    /** `sent`, `failed`, or `not_sent` (no address, or no mail provider here). */
    emailStatus: text("email_status"),
    emailError: text("email_error"),
    /** Taken off the site by the client after approving. */
    removedAt: timestamp("removed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("event_bookings_public_id_key").on(t.publicId),
    uniqueIndex("event_bookings_lead_key")
      .on(t.leadId)
      .where(sql`${t.leadId} IS NOT NULL`),
    index("event_bookings_site_date_idx").on(t.siteId, t.eventDate),
    check("event_bookings_decision_known", sql`${t.decision} IN ('held', 'approved', 'declined')`),
    check(
      "event_bookings_scheduled_has_date",
      sql`${t.decision} = 'declined' OR ${t.eventDate} IS NOT NULL`,
    ),
    check(
      "event_bookings_start_time_shape",
      sql`${t.startTime} IS NULL OR ${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "event_bookings_email_status_known",
      sql`${t.emailStatus} IS NULL OR ${t.emailStatus} IN ('sent', 'failed', 'not_sent')`,
    ),
  ],
);

/**
 * A Growth feature a client has on top of their plan.
 *
 * Two sources, kept apart because they end differently: `stripe` is a line
 * on their subscription, mirrored from Stripe and ended by removing that line;
 * `operator` is one granted by hand — a hand-billed client, a favour — and
 * ended by the operator. What a client's *plan* includes is not stored here at
 * all: that comes from `@mortensenweb/plans`, so changing a plan cannot leave
 * stale rows behind.
 *
 * Ended rows are kept (`ended_at`) as the history of what was bought when.
 * At most one live row per client and feature, enforced by a partial index.
 */
export const clientAddOns = pgTable(
  "client_add_ons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** A `GrowthFeatureKey` from `@mortensenweb/plans`. */
    featureKey: text("feature_key").notNull(),
    source: text("source").notNull(),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    /** What it costs them each month, as charged; null for an operator grant. */
    monthlyPriceCents: integer("monthly_price_cents"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("client_add_ons_live_key")
      .on(t.clientId, t.featureKey)
      .where(sql`${t.endedAt} IS NULL`),
    index("client_add_ons_stripe_item_idx").on(t.stripeSubscriptionItemId),
    check("client_add_ons_source_known", sql`${t.source} IN ('stripe', 'operator')`),
  ],
);
