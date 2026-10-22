-- Paid ads: campaigns a client drafts and pays for in the portal, the
-- channels each one runs on, and the daily results synced back from Google
-- Ads and Meta, with placement and location breakdowns.
--
-- Additive only: three new tables, nothing altered. Code already deployed
-- runs unchanged against this schema, which is why it ships before the code
-- that uses it (Netlify deploys code before the migrate job runs).
--
-- `when` is 1790000000000, above 0028_event_bookings' 1789900000000, the
-- highest on main. Several features are being built at once (0029–0035, each
-- with its own pre-assigned `when`); whoever merges after a higher `when` has
-- reached production must raise theirs, or Drizzle's migrator skips the file
-- silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "ad_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
  "site_id" uuid REFERENCES "sites"("id") ON DELETE set null,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "headlines" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "descriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "call_to_action" text,
  "final_url" text,
  "phone" text,
  "image_asset_id" uuid REFERENCES "media_assets"("id") ON DELETE set null,
  "target_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "target_radius_miles" integer,
  "draft_source" text,
  "draft_facts" jsonb,
  "starts_on" date,
  "ends_on" date,
  "payment_request_id" uuid REFERENCES "payment_requests"("id") ON DELETE set null,
  "spend_budget_cents" integer DEFAULT 0 NOT NULL,
  "management_fee_cents" integer DEFAULT 0 NOT NULL,
  "fee_basis_points" integer,
  "fee_minimum_cents" integer,
  "paid_at" timestamp with time zone,
  "refunded_cents" integer DEFAULT 0 NOT NULL,
  "refund_reference" text,
  "settled_at" timestamp with time zone,
  "review_note" text,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "reviewed_at" timestamp with time zone,
  "launched_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_campaigns_status_known" CHECK ("status" IN ('draft', 'awaiting_payment', 'pending_review', 'rejected', 'approved', 'active', 'paused', 'ended', 'cancelled')),
  CONSTRAINT "ad_campaigns_headlines_array" CHECK (jsonb_typeof("headlines") = 'array'),
  CONSTRAINT "ad_campaigns_descriptions_array" CHECK (jsonb_typeof("descriptions") = 'array'),
  CONSTRAINT "ad_campaigns_target_areas_array" CHECK (jsonb_typeof("target_areas") = 'array'),
  CONSTRAINT "ad_campaigns_money_non_negative" CHECK ("spend_budget_cents" >= 0 AND "management_fee_cents" >= 0 AND "refunded_cents" >= 0),
  CONSTRAINT "ad_campaigns_dates_order" CHECK ("ends_on" IS NULL OR "starts_on" IS NULL OR "ends_on" >= "starts_on")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_campaigns_public_id_key" ON "ad_campaigns" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_campaigns_org_created_idx" ON "ad_campaigns" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_campaigns_status_idx" ON "ad_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_campaigns_payment_request_idx" ON "ad_campaigns" USING btree ("payment_request_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_campaign_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "channel" text NOT NULL,
  "platform" text NOT NULL,
  "budget_cents" integer NOT NULL,
  "launch_mode" text,
  "external_account_id" text,
  "external_campaign_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "spend_micros" bigint DEFAULT 0 NOT NULL,
  "last_synced_at" timestamp with time zone,
  "sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_campaign_channels_channel_known" CHECK ("channel" IN ('google_search', 'google_maps', 'youtube_display', 'facebook', 'instagram')),
  CONSTRAINT "ad_campaign_channels_platform_known" CHECK ("platform" IN ('google_ads', 'meta')),
  CONSTRAINT "ad_campaign_channels_launch_mode_known" CHECK ("launch_mode" IS NULL OR "launch_mode" IN ('api', 'manual')),
  CONSTRAINT "ad_campaign_channels_status_known" CHECK ("status" IN ('pending', 'active', 'paused', 'ended', 'failed')),
  CONSTRAINT "ad_campaign_channels_money_non_negative" CHECK ("budget_cents" >= 0 AND "spend_micros" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_campaign_channels_campaign_channel_key" ON "ad_campaign_channels" USING btree ("campaign_id","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_campaign_channels_external_idx" ON "ad_campaign_channels" USING btree ("platform","external_campaign_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_stats_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  "channel_id" uuid NOT NULL REFERENCES "ad_campaign_channels"("id") ON DELETE cascade,
  "day" date NOT NULL,
  "dimension" text NOT NULL,
  "dimension_value" text DEFAULT '' NOT NULL,
  "impressions" bigint DEFAULT 0 NOT NULL,
  "clicks" bigint DEFAULT 0 NOT NULL,
  "cost_micros" bigint DEFAULT 0 NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "leads" integer DEFAULT 0 NOT NULL,
  "conversions" double precision DEFAULT 0 NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ad_stats_daily_dimension_known" CHECK ("dimension" IN ('total', 'placement', 'location')),
  CONSTRAINT "ad_stats_daily_non_negative" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "cost_micros" >= 0 AND "calls" >= 0 AND "leads" >= 0 AND "conversions" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_stats_daily_key" ON "ad_stats_daily" USING btree ("channel_id","day","dimension","dimension_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_stats_daily_campaign_day_idx" ON "ad_stats_daily" USING btree ("campaign_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_stats_daily_org_day_idx" ON "ad_stats_daily" USING btree ("organization_id","day");
