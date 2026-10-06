import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { sites } from "./sites";
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
     * When the client was emailed about it. Null for a backfilled lead, which
     * is deliberately never announced: connecting a site with a year of
     * history must not send a year of emails.
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
