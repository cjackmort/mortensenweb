import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { sites } from "./sites";

/**
 * QR & campaign tracking: the Growth feature `campaigns`.
 *
 * A campaign is one piece of print — a run of door hangers, a yard sign, the
 * lettering on a truck — with a short link and a QR code that points at the
 * client's own site. Every visit through the short link is a scan.
 */

/** Where a campaign is used. Shown to the client and sent as `utm_source`. */
export const CAMPAIGN_PLACEMENTS = [
  "door_hangers",
  "flyers",
  "yard_signs",
  "truck",
  "business_cards",
  "other",
] as const;

export type CampaignPlacement = (typeof CAMPAIGN_PLACEMENTS)[number];

export const SCAN_DEVICES = ["mobile", "tablet", "desktop", "unknown"] as const;

export type ScanDevice = (typeof SCAN_DEVICES)[number];

/**
 * One campaign.
 *
 * There is no delete, only `pausedAt`. The code is printed on paper that
 * outlives any decision made in the portal, so a paused campaign still
 * redirects and only stops being counted; a code that 404s on a yard sign
 * loses the customer standing in front of it.
 *
 * `utmCampaign` is set once, from the name, and never follows a rename:
 * analytics history is keyed by it, and changing it would split one
 * campaign's visits across two names.
 */
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** The short link's code: `/q/<code>`. Lower case; looked up case-insensitively. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    placement: text("placement").notNull(),
    /** A path on the client's own site. Never a full URL: the origin comes from the site row. */
    destinationPath: text("destination_path").notNull().default("/"),
    utmCampaign: text("utm_campaign").notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("campaigns_public_id_key").on(t.publicId),
    uniqueIndex("campaigns_code_key").on(t.code),
    uniqueIndex("campaigns_org_utm_key").on(t.organizationId, t.utmCampaign),
    index("campaigns_org_created_idx").on(t.organizationId, t.createdAt),
    check(
      "campaigns_placement_known",
      sql`${t.placement} IN ('door_hangers', 'flyers', 'yard_signs', 'truck', 'business_cards', 'other')`,
    ),
    check("campaigns_code_shape", sql`${t.code} ~ '^[a-z0-9]{4,16}$'`),
    check("campaigns_destination_is_path", sql`left(${t.destinationPath}, 1) = '/'`),
  ],
);

/**
 * One counted scan.
 *
 * Deliberately coarse. No IP address is stored, and no coordinates or
 * postcode: the town, the state and the country are what a client needs to
 * judge which streets a door-hanger run reached, and nothing finer.
 *
 * `visitorHash` is an HMAC of the address and browser under a key that
 * changes every day. It lets the redirect count one person scanning twice
 * as one scan, and cap how much any one visitor can add, without the table
 * being able to say who scanned or link one day's scans to the next.
 *
 * `organizationId` is copied from the campaign so the dashboard's queries
 * are tenant-scoped on this table alone.
 */
export const campaignScans = pgTable(
  "campaign_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
    device: text("device").notNull(),
    city: text("city"),
    /** ISO 3166-2 subdivision code without the country: `UT`. */
    region: text("region"),
    /** ISO 3166-1 alpha-2: `US`. */
    country: text("country"),
    visitorHash: text("visitor_hash"),
  },
  (t) => [
    index("campaign_scans_campaign_time_idx").on(t.campaignId, t.scannedAt),
    index("campaign_scans_org_time_idx").on(t.organizationId, t.scannedAt),
    index("campaign_scans_visitor_time_idx").on(t.visitorHash, t.scannedAt),
    check(
      "campaign_scans_device_known",
      sql`${t.device} IN ('mobile', 'tablet', 'desktop', 'unknown')`,
    ),
  ],
);
