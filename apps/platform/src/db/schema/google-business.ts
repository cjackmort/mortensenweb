import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { clients } from "./clients";

/**
 * Google profile management: the Growth feature where the agency keeps a
 * client's Google Business Profile current — hours, posts, photos, review
 * replies. See `src/lib/google-business/` for the API side.
 *
 * Its own file rather than more of `growth.ts`, so the Growth features being
 * built in parallel each add a file instead of all editing one.
 *
 * The shape of the access, which explains most of these tables: the agency
 * connects **one** Google account (operator-level OAuth), and each client adds
 * that account as a Manager on their own profile. So there is one connection
 * row, and one location row per client pointing into what that connection
 * can see. Nothing here is a client credential.
 */

/**
 * The agency's Google account, connected once by the operator.
 *
 * The refresh token is sealed with libsodium's secretbox under
 * `GOOGLE_TOKEN_KEY` before it is written (`lib/google-business/seal.ts`);
 * this table never sees it in the clear, and no access token is stored at all
 * — they last an hour and are minted from the refresh token when needed.
 *
 * At most one live row (`revoked_at IS NULL`). Reconnecting revokes the old
 * row rather than updating it, so "who connected which account, when" stays
 * answerable.
 *
 * `quota_paused_until` is set when Google answers 429: every sync stops until
 * then. One project-wide quota covers every client, so one client's backlog
 * must not be allowed to spend everyone's.
 *
 * `last_success_at` is what tells "Google has not granted this project API
 * access" from "Google is rate-limiting us for a minute". An unapproved
 * project has a quota of zero, so both answer 429; only a connection that has
 * never had a call succeed is the first.
 */
export const googleConnections = pgTable(
  "google_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    googleEmail: text("google_email").notNull(),
    /** Google's stable account id (`sub`); the email can change. */
    googleSubject: text("google_subject").notNull(),
    scope: text("scope").notNull(),
    refreshTokenSealed: text("refresh_token_sealed").notNull(),
    connectedBy: uuid("connected_by").references(() => users.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** The last failure talking to Google with this account, shown to the operator. */
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** The last call to Google with this account that succeeded. */
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    quotaPausedUntil: timestamp("quota_paused_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("google_connections_one_live")
      .on(sql`(true)`)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/**
 * Which Google location is which client's, and what it last said.
 *
 * `snapshot` is the profile as last read from Google, normalised
 * (`ProfileSnapshot` in `lib/google-business/types.ts`): name, phone,
 * website, categories, description, hours, special hours, the review link.
 * A JSON object rather than columns because Google adds and renames fields,
 * and this is a cache of their record, not ours. Null until the first sync —
 * which the pages say, rather than showing an empty profile.
 *
 * The sync bookkeeping lives here too: `next_sync_at` is the per-location
 * backoff, pushed out further after each consecutive failure.
 */
export const googleLocations = pgTable(
  "google_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** Tenancy key. Client-facing queries filter on this column. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `accounts/123` — the account the location is reached through (v4 paths need it). */
    accountName: text("account_name").notNull(),
    /** `locations/456`. */
    locationName: text("location_name").notNull(),
    title: text("title"),
    snapshot: jsonb("snapshot"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    averageRating: real("average_rating"),
    reviewCount: integer("review_count"),
    photoCount: integer("photo_count"),
    /** The newest post on the profile, whoever made it. Drives "stale posts". */
    lastPostAt: timestamp("last_post_at", { withTimezone: true }),
    linkedBy: uuid("linked_by").references(() => users.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metricsSyncedAt: timestamp("metrics_synced_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    syncFailures: integer("sync_failures").notNull().default(0),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("google_locations_client_key").on(t.clientId),
    // Two clients pointing at one profile is always a mistake, and would show
    // one business's reviews to another.
    uniqueIndex("google_locations_location_key").on(t.locationName),
    index("google_locations_org_idx").on(t.organizationId),
    index("google_locations_next_sync_idx").on(t.nextSyncAt),
    check(
      "google_locations_snapshot_object",
      sql`${t.snapshot} IS NULL OR jsonb_typeof(${t.snapshot}) = 'object'`,
    ),
  ],
);

/**
 * A review on a client's profile, and where its reply stands.
 *
 * `reply_comment` is what is published on Google — written by the sync, or by
 * posting a reply. `draft_reply` is a reply nobody has published: drafted by
 * the portal from the review and the business's details, or edited by the
 * operator. Nothing posts a draft except an operator pressing the button.
 *
 * `removed_at` marks a review that a complete sync no longer found on Google
 * (deleted by its author, or removed by Google). Kept rather than deleted, so a
 * reply drafted for it is not silently lost, and dropped from every queue.
 */
export const googleReviews = pgTable(
  "google_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => googleLocations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    googleReviewId: text("google_review_id").notNull(),
    reviewerName: text("reviewer_name"),
    /** 1–5. Null when Google reports the rating as unspecified. */
    starRating: integer("star_rating"),
    comment: text("comment"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    replyComment: text("reply_comment"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    draftReply: text("draft_reply"),
    /** `portal` (drafted automatically) or `operator` (edited by hand). */
    draftSource: text("draft_source"),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }),
    /** Why the last attempt to publish the reply failed. Cleared on success. */
    replyError: text("reply_error"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("google_reviews_location_review_key").on(t.locationId, t.googleReviewId),
    index("google_reviews_org_posted_idx").on(t.organizationId, t.postedAt),
    check(
      "google_reviews_star_range",
      sql`${t.starRating} IS NULL OR ${t.starRating} BETWEEN 1 AND 5`,
    ),
    check(
      "google_reviews_draft_source_known",
      sql`${t.draftSource} IS NULL OR ${t.draftSource} IN ('portal', 'operator')`,
    ),
  ],
);

/**
 * One day of a location's Performance figures, as Google reports them.
 *
 * A row means Google answered for that day; a day with no row is a day we
 * have no figures for, which is not the same as a day of zeros. Google itself
 * omits zero values, so the sync writes zeros explicitly for the days it asked
 * about and got an answer for.
 */
export const googleDailyMetrics = pgTable(
  "google_daily_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => googleLocations.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** Profile shown in Google Search results, desktop and mobile. */
    searchViews: integer("search_views").notNull().default(0),
    /** Profile shown on Google Maps, desktop and mobile. */
    mapsViews: integer("maps_views").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    websiteClicks: integer("website_clicks").notNull().default(0),
    directionRequests: integer("direction_requests").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("google_daily_metrics_location_date_key").on(t.locationId, t.date)],
);

/**
 * What people searched for when the profile was shown, by month.
 *
 * Google reports this monthly only, and reports small counts as "fewer than
 * N" rather than a number: `impressions` is null and `below_threshold` holds
 * N for those. A month's total is therefore a floor, and the page says so.
 */
export const googleSearchKeywords = pgTable(
  "google_search_keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => googleLocations.id, { onDelete: "cascade" }),
    /** The first of the month. */
    month: date("month").notNull(),
    keyword: text("keyword").notNull(),
    impressions: integer("impressions"),
    belowThreshold: integer("below_threshold"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("google_search_keywords_key").on(t.locationId, t.month, t.keyword),
    check(
      "google_search_keywords_one_value",
      sql`(${t.impressions} IS NULL) <> (${t.belowThreshold} IS NULL)`,
    ),
  ],
);

/**
 * A change a client asked for on their Google profile — "change my holiday
 * hours" — waiting in the operator's queue.
 *
 * Separate from `change_requests` on purpose: those dispatch an agent run
 * against the client's website repository, and a Google profile is not in
 * any repository. A profile change is made by the operator, here.
 */
export const googleProfileRequests = pgTable(
  "google_profile_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    status: text("status").notNull().default("open"),
    /** Shown to the client beside the request once it is closed. */
    operatorNote: text("operator_note"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("google_profile_requests_public_id_key").on(t.publicId),
    index("google_profile_requests_status_idx").on(t.status, t.createdAt),
    index("google_profile_requests_org_idx").on(t.organizationId, t.createdAt),
    check(
      "google_profile_requests_status_known",
      sql`${t.status} IN ('open', 'done', 'declined')`,
    ),
  ],
);

/**
 * Everything the portal changed on a client's Google profile: hours, special
 * hours, description, a post, a photo, a review reply.
 *
 * Written whether the change landed or not (`status`), with what Google held
 * before and what was sent — so "who changed the hours, and from what" has an
 * answer, and a failed edit is visible rather than assumed to have worked.
 */
export const googleProfileChanges = pgTable(
  "google_profile_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => googleLocations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    status: text("status").notNull(),
    error: text("error"),
    /** The resource Google created, for a post or a photo. */
    googleName: text("google_name"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The client's ask this change answered, when there was one. */
    requestId: uuid("request_id").references(() => googleProfileRequests.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("google_profile_changes_location_idx").on(t.locationId, t.createdAt),
    index("google_profile_changes_org_idx").on(t.organizationId, t.createdAt),
    check(
      "google_profile_changes_kind_known",
      sql`${t.kind} IN ('hours', 'special_hours', 'description', 'post', 'photo', 'review_reply')`,
    ),
    check("google_profile_changes_status_known", sql`${t.status} IN ('applied', 'failed')`),
  ],
);
