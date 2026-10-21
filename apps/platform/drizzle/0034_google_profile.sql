-- Google profile management: the agency's Google connection, each client's
-- location, its reviews, Performance figures, search terms, the client's
-- change asks, and a log of every change the portal made on the profile.
--
-- Additive only: seven new tables. No existing table or column changes, so
-- code already deployed runs unchanged against this schema.
--
-- `when` is 1790500000000, assigned to this feature among the migrations
-- being built in parallel (0028 bookings through 0035). Drizzle applies by a
-- single `when` high-water mark, so whichever of these merges after a
-- higher-numbered one must have its `when` raised above main's highest first.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "google_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "google_email" text NOT NULL,
  "google_subject" text NOT NULL,
  "scope" text NOT NULL,
  "refresh_token_sealed" text NOT NULL,
  "connected_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "quota_paused_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_connections_one_live" ON "google_connections" USING btree ((true)) WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "account_name" text NOT NULL,
  "location_name" text NOT NULL,
  "title" text,
  "snapshot" jsonb,
  "snapshot_at" timestamp with time zone,
  "average_rating" real,
  "review_count" integer,
  "photo_count" integer,
  "last_post_at" timestamp with time zone,
  "linked_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_synced_at" timestamp with time zone,
  "metrics_synced_at" timestamp with time zone,
  "next_sync_at" timestamp with time zone,
  "sync_failures" integer DEFAULT 0 NOT NULL,
  "last_sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "google_locations_snapshot_object" CHECK ("snapshot" IS NULL OR jsonb_typeof("snapshot") = 'object')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_locations_client_key" ON "google_locations" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_locations_location_key" ON "google_locations" USING btree ("location_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_locations_org_idx" ON "google_locations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_locations_next_sync_idx" ON "google_locations" USING btree ("next_sync_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "google_locations"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "google_review_id" text NOT NULL,
  "reviewer_name" text,
  "star_rating" integer,
  "comment" text,
  "posted_at" timestamp with time zone NOT NULL,
  "edited_at" timestamp with time zone,
  "reply_comment" text,
  "replied_at" timestamp with time zone,
  "draft_reply" text,
  "draft_source" text,
  "draft_updated_at" timestamp with time zone,
  "reply_error" text,
  "removed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "google_reviews_star_range" CHECK ("star_rating" IS NULL OR "star_rating" BETWEEN 1 AND 5),
  CONSTRAINT "google_reviews_draft_source_known" CHECK ("draft_source" IS NULL OR "draft_source" IN ('portal', 'operator'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_reviews_location_review_key" ON "google_reviews" USING btree ("location_id","google_review_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_reviews_org_posted_idx" ON "google_reviews" USING btree ("organization_id","posted_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_daily_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "google_locations"("id") ON DELETE cascade,
  "date" date NOT NULL,
  "search_views" integer DEFAULT 0 NOT NULL,
  "maps_views" integer DEFAULT 0 NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "website_clicks" integer DEFAULT 0 NOT NULL,
  "direction_requests" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_daily_metrics_location_date_key" ON "google_daily_metrics" USING btree ("location_id","date");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_search_keywords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "google_locations"("id") ON DELETE cascade,
  "month" date NOT NULL,
  "keyword" text NOT NULL,
  "impressions" integer,
  "below_threshold" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "google_search_keywords_one_value" CHECK (("impressions" IS NULL) <> ("below_threshold" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_search_keywords_key" ON "google_search_keywords" USING btree ("location_id","month","keyword");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_profile_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "body" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "operator_note" text,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "google_profile_requests_status_known" CHECK ("status" IN ('open', 'done', 'declined'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "google_profile_requests_public_id_key" ON "google_profile_requests" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_profile_requests_status_idx" ON "google_profile_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_profile_requests_org_idx" ON "google_profile_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_profile_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "google_locations"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "status" text NOT NULL,
  "error" text,
  "google_name" text,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "request_id" uuid REFERENCES "google_profile_requests"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "google_profile_changes_kind_known" CHECK ("kind" IN ('hours', 'special_hours', 'description', 'post', 'photo', 'review_reply')),
  CONSTRAINT "google_profile_changes_status_known" CHECK ("status" IN ('applied', 'failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_profile_changes_location_idx" ON "google_profile_changes" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "google_profile_changes_org_idx" ON "google_profile_changes" USING btree ("organization_id","created_at");
