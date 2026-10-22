import { sql } from "drizzle-orm";
import {
  check,
  date,
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
 * Win-back emails: seasonal reminders and offers to a client's past
 * customers, written by the portal, edited and approved by the client, and
 * sent through Resend. See `lib/winback/`.
 *
 * In its own file rather than appended to `growth.ts`, so the Growth
 * features being built side by side touch different files.
 */

/**
 * A past customer the client may email.
 *
 * Two ways in: an enquiry the client marked won in the leads inbox, or a row
 * of a CSV they imported. `howBecameCustomer` says which, in the client's
 * terms, because "why is this person getting my emails?" is a question a
 * business must be able to answer about every address it sends to.
 *
 * One row per address per organization: the dedupe key is the lowercased
 * email, so importing the same spreadsheet twice adds nobody.
 */
export const winbackContacts = pgTable(
  "winback_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercased and trimmed; the dedupe key. */
    email: text("email").notNull(),
    name: text("name"),
    /** `lead` (won in the inbox), `import` (CSV) or `manual`. */
    source: text("source").notNull(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** "Won enquiry from your website, 3 Oct 2026" — shown beside them. */
    howBecameCustomer: text("how_became_customer").notNull(),
    /** Their last job, when the import had a column for it. */
    lastJobOn: date("last_job_on"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("winback_contacts_public_id_key").on(t.publicId),
    uniqueIndex("winback_contacts_org_email_key").on(t.organizationId, t.email),
    index("winback_contacts_org_created_idx").on(t.organizationId, t.createdAt),
    check("winback_contacts_source_known", sql`${t.source} IN ('lead', 'import', 'manual')`),
  ],
);

/**
 * Addresses a client's win-back emails must never go to again.
 *
 * Checked before every single send, not once per campaign: someone who
 * unsubscribes from the first email of a batch must not get the second
 * campaign that was approved last week.
 *
 * `ipHash` is set on an unsubscribe and nothing else — it is what the public
 * unsubscribe endpoint rate-limits on.
 */
export const winbackSuppressions = pgTable(
  "winback_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** `unsubscribed`, `bounced`, `complained` or `manual`. */
    reason: text("reason").notNull(),
    campaignId: uuid("campaign_id").references(() => winbackCampaigns.id, { onDelete: "set null" }),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("winback_suppressions_org_email_key").on(t.organizationId, t.email),
    index("winback_suppressions_ip_created_idx").on(t.ipHash, t.createdAt),
    check(
      "winback_suppressions_reason_known",
      sql`${t.reason} IN ('unsubscribed', 'bounced', 'complained', 'manual')`,
    ),
  ],
);

/**
 * One email, written once and sent to many past customers.
 *
 * `status` moves draft → approved → sending → sent. Nothing leaves `draft`
 * without a person in the client's organization pressing Approve; nothing is
 * sent from any other state than `approved` or `sending`. `cancelled` is the
 * client taking it back before it went; `halted` is the operator's kill
 * switch, and only the operator can set it.
 *
 * `fromName`, `replyTo` and `postalAddress` are copied from General
 * information at approval, so what goes out is exactly what the client
 * approved even if the profile changes while it is sending.
 */
export const winbackCampaigns = pgTable(
  "winback_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Which suggestion it started from (`hvac-furnace`), or `custom`. */
    occasionKey: text("occasion_key").notNull(),
    /** The client's own label for it: "Before the holidays". */
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    offer: text("offer"),
    offerExpiresOn: date("offer_expires_on"),
    status: text("status").notNull().default("draft"),
    /** Null: send as soon as it is approved. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    fromName: text("from_name"),
    replyTo: text("reply_to"),
    postalAddress: text("postal_address"),
    sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    haltedAt: timestamp("halted_at", { withTimezone: true }),
    haltedBy: uuid("halted_by").references(() => users.id, { onDelete: "set null" }),
    haltReason: text("halt_reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("winback_campaigns_public_id_key").on(t.publicId),
    index("winback_campaigns_org_created_idx").on(t.organizationId, t.createdAt),
    index("winback_campaigns_status_scheduled_idx").on(t.status, t.scheduledFor),
    check(
      "winback_campaigns_status_known",
      sql`${t.status} IN ('draft', 'approved', 'sending', 'sent', 'cancelled', 'halted')`,
    ),
  ],
);

/**
 * One campaign to one address: the unit of sending, and of results.
 *
 * Unique on (campaign, email), so one person gets one copy however many times
 * the send is retried or the contact list was imported. The row is claimed
 * (`pending` → `sending`) before the email goes and settled after; Resend's
 * idempotency key is derived from `publicId`, so a send retried after a crash
 * between the two is answered with the first email rather than a second.
 *
 * Delivery, opens, clicks, bounces and complaints arrive later by signed
 * webhook and are stamped once — the first time each happened.
 */
export const winbackRecipients = pgTable(
  "winback_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => winbackCampaigns.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => winbackContacts.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    /** For the greeting, as it was when the campaign was approved. */
    name: text("name"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    complainedAt: timestamp("complained_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("winback_recipients_public_id_key").on(t.publicId),
    uniqueIndex("winback_recipients_campaign_email_key").on(t.campaignId, t.email),
    index("winback_recipients_campaign_status_idx").on(t.campaignId, t.status),
    index("winback_recipients_provider_message_idx").on(t.providerMessageId),
    index("winback_recipients_org_idx").on(t.organizationId),
    check(
      "winback_recipients_status_known",
      sql`${t.status} IN ('pending', 'sending', 'sent', 'failed', 'suppressed', 'not_sent', 'halted')`,
    ),
  ],
);
