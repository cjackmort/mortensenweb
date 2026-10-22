import { sql } from "drizzle-orm";
import {
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
import { sites } from "./sites";
import { changeRequests } from "./operations";
import { mediaAssets } from "./media";

/**
 * Job showcase: photos of a finished job, and a few words about it, become a
 * page on the client's site, a Google post and social graphics.
 *
 * The client's own words (`job`, `town`, `notes`) are kept apart from the
 * drafted text (`title`, `write_up`, `caption`) so the draft can be rebuilt
 * from what they actually said, and so anyone checking a published claim can
 * see where it came from. The draft is written from those words and General
 * information only; nothing in it is invented.
 *
 * Each output carries its own state, because they finish at different times
 * and fail for different reasons:
 *
 *  - **Site page** is an ordinary change request (`site_request_id`), so it
 *    goes through the preview-approval flow and counts against the client's
 *    changes like any other. When one could not be opened, the reason is
 *    recorded rather than lost, and the client can send it again.
 *  - **Google** is `manual` until a Business Profile connection exists, then
 *    `posted` or `failed`.
 *  - **Graphics** are rendered on request from the photos, so they have no
 *    state to store.
 */
export const showcases = pgTable(
  "showcases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Where the page goes. Null for a client with no site yet. */
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),

    /** What the job was, in the client's words. */
    job: text("job").notNull(),
    town: text("town").notNull(),
    /** Anything else they said about it, verbatim. */
    notes: text("notes"),

    /** Drafted by the portal, edited by the client. What gets published. */
    title: text("title").notNull(),
    writeUp: text("write_up").notNull(),
    /** Suggested text for a social post. */
    caption: text("caption").notNull(),

    /** `draft` until the client approves the wording; nothing is published before. */
    status: text("status").notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),

    siteRequestId: uuid("site_request_id").references(() => changeRequests.id, {
      onDelete: "set null",
    }),
    /** Why the page could not be sent to the site yet. Cleared once it is. */
    siteBlockedReason: text("site_blocked_reason"),

    /** `manual`, `posted` or `failed`. Null before approval. */
    googleStatus: text("google_status"),
    /** The post's resource name at Google, when the portal published it. */
    googlePostName: text("google_post_name"),
    googlePostedAt: timestamp("google_posted_at", { withTimezone: true }),
    googleError: text("google_error"),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("showcases_public_id_key").on(t.publicId),
    index("showcases_org_created_idx").on(t.organizationId, t.createdAt),
    index("showcases_site_request_idx").on(t.siteRequestId),
    check("showcases_status_known", sql`${t.status} IN ('draft', 'approved')`),
    check(
      "showcases_approved_stamped",
      sql`${t.status} <> 'approved' OR ${t.approvedAt} IS NOT NULL`,
    ),
    check(
      "showcases_google_status_known",
      sql`${t.googleStatus} IS NULL OR ${t.googleStatus} IN ('manual', 'posted', 'failed')`,
    ),
    check(
      "showcases_site_blocked_known",
      sql`${t.siteBlockedReason} IS NULL OR ${t.siteBlockedReason} IN ('no_site', 'locked', 'one_at_a_time', 'allowance_exhausted', 'photos_not_ready', 'failed')`,
    ),
  ],
);

/**
 * A library photo in a showcase, in the order the client chose.
 *
 * `before` and `after` mark an optional pairing, at most one of each per
 * showcase. Cascades with the asset rather than restricting it: a photo
 * purged from the library takes its place in a showcase with it, where a
 * restriction would make the library's purge fail on a table it knows
 * nothing about.
 */
export const showcasePhotos = pgTable(
  "showcase_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showcaseId: uuid("showcase_id")
      .notNull()
      .references(() => showcases.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    role: text("role").notNull().default("photo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("showcase_photos_showcase_asset_key").on(t.showcaseId, t.assetId),
    uniqueIndex("showcase_photos_pair_role_key")
      .on(t.showcaseId, t.role)
      .where(sql`${t.role} IN ('before', 'after')`),
    index("showcase_photos_asset_idx").on(t.assetId),
    check("showcase_photos_role_known", sql`${t.role} IN ('photo', 'before', 'after')`),
  ],
);
