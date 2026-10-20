-- QR & campaign tracking: a client's printed campaigns (door hangers, flyers,
-- yard signs, trucks) and every scan of their short links.
--
-- Additive only: two new tables. Code already deployed runs unchanged
-- against this schema.
--
-- `when` is 1790100000000. 0028 (event bookings) and 0029 (ads) are in
-- flight on other branches below it; Drizzle skips anything below the highest
-- `when` already applied, so whichever of those merges after this one must
-- raise its own `when` first.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on
-- this repository. No session state between statements: production migrates
-- over Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "placement" text NOT NULL,
  "destination_path" text DEFAULT '/' NOT NULL,
  "utm_campaign" text NOT NULL,
  "paused_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaigns_placement_known" CHECK ("placement" IN ('door_hangers', 'flyers', 'yard_signs', 'truck', 'business_cards', 'other')),
  CONSTRAINT "campaigns_code_shape" CHECK ("code" ~ '^[a-z0-9]{4,16}$'),
  CONSTRAINT "campaigns_destination_is_path" CHECK (left("destination_path", 1) = '/')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_public_id_key" ON "campaigns" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_code_key" ON "campaigns" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_org_utm_key" ON "campaigns" USING btree ("organization_id","utm_campaign");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_org_created_idx" ON "campaigns" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_scans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "device" text NOT NULL,
  "city" text,
  "region" text,
  "country" text,
  "visitor_hash" text,
  CONSTRAINT "campaign_scans_device_known" CHECK ("device" IN ('mobile', 'tablet', 'desktop', 'unknown'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_scans_campaign_time_idx" ON "campaign_scans" USING btree ("campaign_id","scanned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_scans_org_time_idx" ON "campaign_scans" USING btree ("organization_id","scanned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_scans_visitor_time_idx" ON "campaign_scans" USING btree ("visitor_hash","scanned_at");
