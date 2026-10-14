import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  doublePrecision,
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
import { clients, paymentRequests } from "./clients";
import { mediaAssets } from "./media";

/**
 * Paid ads: a campaign a client drafts in the portal, pays for once, and
 * watches run on Google and Meta.
 *
 * Statuses are text with a CHECK rather than Postgres enums, so a later state
 * is a one-line constraint change instead of an `ALTER TYPE` that cannot run
 * inside the migrator's transaction alongside anything that uses the value.
 */

/**
 * One ad campaign: the creative, the money, and where it is in its life.
 *
 * The money columns are copied at checkout and never recomputed from config.
 * The management fee's percentage and minimum live in `@mortensenweb/plans`
 * and the operator may change them; a campaign already paid for must keep
 * the terms the client saw, or a settled refund would be worked out against
 * a fee they never agreed to.
 *
 *   draft → awaiting_payment → pending_review → approved → active ⇄ paused → ended
 *                                    ↓                         ↓
 *                                 rejected ─────────────→ cancelled
 *
 * `rejected` is the operator's ad-policy refusal: the client can edit and
 * resubmit, or the campaign is cancelled and refunded in full. `cancelled`
 * is anything that ends without running.
 */
export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** The site the ad sends people to, when it is one of theirs. */
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),

    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),

    // ---- The creative --------------------------------------------------
    /** Short lines, 30 characters each for Google. `["…", "…"]`. */
    headlines: jsonb("headlines").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Longer lines, 90 characters each for Google. */
    descriptions: jsonb("descriptions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** `call`, `book`, `quote`, `learn_more` — mapped to each platform's own button. */
    callToAction: text("call_to_action"),
    /** Where a click lands. */
    finalUrl: text("final_url"),
    /** The number a call button dials. Copied from the profile, editable. */
    phone: text("phone"),
    imageAssetId: uuid("image_asset_id").references(() => mediaAssets.id, {
      onDelete: "set null",
    }),
    /** Towns, counties or regions, as the client wrote them. */
    targetAreas: jsonb("target_areas").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Around the business address, when it has one and the client chose a radius. */
    targetRadiusMiles: integer("target_radius_miles"),

    /**
     * How the first draft was written — `template` or `claude` — and the
     * profile facts it was given. Kept so "where did this claim come from" is
     * answerable from the row: anything in the ad that is not in `draftFacts`
     * was typed by the client.
     */
    draftSource: text("draft_source"),
    draftFacts: jsonb("draft_facts").$type<Record<string, string>>(),

    // ---- When ----------------------------------------------------------
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),

    // ---- The money -----------------------------------------------------
    paymentRequestId: uuid("payment_request_id").references(() => paymentRequests.id, {
      onDelete: "set null",
    }),
    /** Sum of the channel budgets: what goes to Google and Meta. */
    spendBudgetCents: integer("spend_budget_cents").notNull().default(0),
    /** Our fee, its own line on the checkout. Never folded into the spend. */
    managementFeeCents: integer("management_fee_cents").notNull().default(0),
    /** The fee terms at checkout: basis points (1500 = 15%) and the floor. */
    feeBasisPoints: integer("fee_basis_points"),
    feeMinimumCents: integer("fee_minimum_cents"),
    paidAt: timestamp("paid_at", { withTimezone: true }),

    /**
     * Money given back: the unspent budget and the fee on it at the end, or
     * everything for a campaign that never ran. Cumulative; the ledger's
     * `payment_adjustments` holds each refund itself.
     */
    refundedCents: integer("refunded_cents").notNull().default(0),
    refundReference: text("refund_reference"),
    /** The campaign's money is final: refunded, or nothing was owed back. */
    settledAt: timestamp("settled_at", { withTimezone: true }),

    // ---- The operator's side -------------------------------------------
    /** Why it was rejected, in words the client is shown. */
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_campaigns_public_id_key").on(t.publicId),
    index("ad_campaigns_org_created_idx").on(t.organizationId, t.createdAt),
    index("ad_campaigns_status_idx").on(t.status),
    index("ad_campaigns_payment_request_idx").on(t.paymentRequestId),
    check(
      "ad_campaigns_status_known",
      sql`${t.status} IN ('draft', 'awaiting_payment', 'pending_review', 'rejected', 'approved', 'active', 'paused', 'ended', 'cancelled')`,
    ),
    check("ad_campaigns_headlines_array", sql`jsonb_typeof(${t.headlines}) = 'array'`),
    check("ad_campaigns_descriptions_array", sql`jsonb_typeof(${t.descriptions}) = 'array'`),
    check("ad_campaigns_target_areas_array", sql`jsonb_typeof(${t.targetAreas}) = 'array'`),
    check(
      "ad_campaigns_money_non_negative",
      sql`${t.spendBudgetCents} >= 0 AND ${t.managementFeeCents} >= 0 AND ${t.refundedCents} >= 0`,
    ),
    check(
      "ad_campaigns_dates_order",
      sql`${t.endsOn} IS NULL OR ${t.startsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
);

/**
 * Where a campaign runs, and how much of its budget each place gets.
 *
 * One row per channel the client chose. On launch it gains the platform's own
 * ids — by API, or pasted in by the operator after building the campaign in
 * Google's or Meta's own screens — and from then on it is what the stats sync
 * reads by.
 */
export const adCampaignChannels = pgTable(
  "ad_campaign_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    /** `google_search`, `google_maps`, `youtube_display`, `facebook`, `instagram`. */
    channel: text("channel").notNull(),
    /** `google_ads` or `meta`. Which API launches and reports on it. */
    platform: text("platform").notNull(),
    budgetCents: integer("budget_cents").notNull(),

    /** `api` when the portal created it, `manual` when the operator pasted the ids. */
    launchMode: text("launch_mode"),
    /** Google Ads customer id, or Meta ad account id (`act_…`). */
    externalAccountId: text("external_account_id"),
    externalCampaignId: text("external_campaign_id"),
    status: text("status").notNull().default("pending"),

    /** Lifetime spend, from the last sync. The daily rows are the detail. */
    spendMicros: bigint("spend_micros", { mode: "number" }).notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** The last sync's failure, shown to the operator; cleared on success. */
    syncError: text("sync_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_campaign_channels_campaign_channel_key").on(t.campaignId, t.channel),
    index("ad_campaign_channels_external_idx").on(t.platform, t.externalCampaignId),
    check(
      "ad_campaign_channels_channel_known",
      sql`${t.channel} IN ('google_search', 'google_maps', 'youtube_display', 'facebook', 'instagram')`,
    ),
    check("ad_campaign_channels_platform_known", sql`${t.platform} IN ('google_ads', 'meta')`),
    check(
      "ad_campaign_channels_launch_mode_known",
      sql`${t.launchMode} IS NULL OR ${t.launchMode} IN ('api', 'manual')`,
    ),
    check(
      "ad_campaign_channels_status_known",
      sql`${t.status} IN ('pending', 'active', 'paused', 'ended', 'failed')`,
    ),
    check(
      "ad_campaign_channels_money_non_negative",
      sql`${t.budgetCents} >= 0 AND ${t.spendMicros} >= 0`,
    ),
  ],
);

/**
 * One day of one channel's results, as the platform reported it.
 *
 * Three kinds of row share the table, told apart by `dimension`: the day's
 * `total`, one row per `placement` (Google Search, Maps, YouTube, Display;
 * Facebook Feed, Instagram Stories, Reels, Messenger, Audience Network …) and
 * one per `location` (a city or region). The breakdowns are separate queries
 * on both platforms and need not sum exactly to the total — a click with no
 * known location is in the total and in no location row — so the report reads
 * totals from `total` rows and never adds up a breakdown to get one.
 *
 * Upserted on `(channel, day, dimension, value)`: a platform revises recent
 * days as late conversions arrive, and a re-sync must replace the day rather
 * than add to it.
 *
 * Cost is in micros because that is what Google sends, and Meta's decimal
 * spend converts to it exactly; rounding each placement to cents would make
 * the placements disagree with the total by a cent here and there.
 */
export const adStatsDaily = pgTable(
  "ad_stats_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => adCampaignChannels.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    dimension: text("dimension").notNull(),
    /** Empty for a total; a placement key, or a place name. */
    dimensionValue: text("dimension_value").notNull().default(""),

    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** Calls from the ad's call button or call extension. */
    calls: integer("calls").notNull().default(0),
    /** Lead-form submissions on the platform itself. */
    leads: integer("leads").notNull().default(0),
    /**
     * Conversions as the platform counts them. Fractional on Google, whose
     * attribution splits one conversion across several clicks.
     */
    conversions: doublePrecision("conversions").notNull().default(0),

    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_stats_daily_key").on(t.channelId, t.day, t.dimension, t.dimensionValue),
    index("ad_stats_daily_campaign_day_idx").on(t.campaignId, t.day),
    index("ad_stats_daily_org_day_idx").on(t.organizationId, t.day),
    check(
      "ad_stats_daily_dimension_known",
      sql`${t.dimension} IN ('total', 'placement', 'location')`,
    ),
    check(
      "ad_stats_daily_non_negative",
      sql`${t.impressions} >= 0 AND ${t.clicks} >= 0 AND ${t.costMicros} >= 0 AND ${t.calls} >= 0 AND ${t.leads} >= 0 AND ${t.conversions} >= 0`,
    ),
  ],
);
