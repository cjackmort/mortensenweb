-- Availability: "Set your availability" for clients with booking_enabled.
--
-- Four new tables — a client's booking rules, their weekly hours, dates with
-- their own hours, and the appointments booked on their website — and one
-- widened check: connected_accounts may now hold a `google_calendar`
-- connection, read for busy times only (calendar.freebusy).
--
-- The double-booking guard is the partial unique index on
-- appointment_bookings (organization_id, starts_at) for pending and
-- confirmed rows: two visitors booking the same slot at the same instant
-- cannot both succeed, whatever order their requests arrive in.
--
-- Additive: every CREATE is IF NOT EXISTS, foreign keys sit inside CREATE
-- TABLE so a re-run is harmless. The provider check is dropped and re-added
-- wider in one go; every row that passed the old check passes the new one.
--
-- `when` is 1791700000000, above 0043_client_sections (1791600000000).
-- Drizzle's migrator skips anything at or below the highest applied `when`,
-- so this must stay the highest until it has run in production.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

CREATE TABLE IF NOT EXISTS "availability_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "time_zone" text DEFAULT 'America/Denver' NOT NULL,
  "slot_minutes" integer DEFAULT 30 NOT NULL,
  "buffer_minutes" integer DEFAULT 0 NOT NULL,
  "min_notice_minutes" integer DEFAULT 120 NOT NULL,
  "horizon_days" integer DEFAULT 30 NOT NULL,
  "requires_approval" boolean DEFAULT false NOT NULL,
  "calendar_id" text,
  "busy_cache" jsonb,
  "busy_checked_at" timestamp with time zone,
  "busy_error" text,
  "busy_error_at" timestamp with time zone,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "availability_settings_slot_range" CHECK ("slot_minutes" BETWEEN 5 AND 480),
  CONSTRAINT "availability_settings_buffer_range" CHECK ("buffer_minutes" BETWEEN 0 AND 240),
  CONSTRAINT "availability_settings_notice_range" CHECK ("min_notice_minutes" BETWEEN 0 AND 43200),
  CONSTRAINT "availability_settings_horizon_range" CHECK ("horizon_days" BETWEEN 1 AND 90),
  CONSTRAINT "availability_settings_busy_cache_object" CHECK ("busy_cache" IS NULL OR jsonb_typeof("busy_cache") = 'object'),
  CONSTRAINT "availability_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "availability_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "availability_settings_org_key" ON "availability_settings" USING btree ("organization_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "availability_weekly_hours" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "weekday" integer NOT NULL,
  "ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "availability_weekly_hours_weekday" CHECK ("weekday" BETWEEN 0 AND 6),
  CONSTRAINT "availability_weekly_hours_ranges_array" CHECK (jsonb_typeof("ranges") = 'array'),
  CONSTRAINT "availability_weekly_hours_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "availability_weekly_hours_day_key" ON "availability_weekly_hours" USING btree ("organization_id", "weekday");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "availability_date_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "date" date NOT NULL,
  "ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "availability_date_overrides_ranges_array" CHECK (jsonb_typeof("ranges") = 'array'),
  CONSTRAINT "availability_date_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "availability_date_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "availability_date_overrides_public_id_key" ON "availability_date_overrides" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "availability_date_overrides_day_key" ON "availability_date_overrides" USING btree ("organization_id", "date");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "appointment_bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "site_id" uuid NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "time_zone" text NOT NULL,
  "customer_name" text NOT NULL,
  "customer_email" text NOT NULL,
  "customer_phone" text,
  "note" text,
  "status" text NOT NULL,
  "decided_by" uuid,
  "decided_at" timestamp with time zone,
  "customer_email_status" text,
  "customer_email_error" text,
  "client_email_status" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "appointment_bookings_order" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "appointment_bookings_status_known" CHECK ("status" IN ('pending', 'confirmed', 'declined', 'cancelled')),
  CONSTRAINT "appointment_bookings_customer_email_status_known" CHECK ("customer_email_status" IS NULL OR "customer_email_status" IN ('sent', 'failed', 'not_sent')),
  CONSTRAINT "appointment_bookings_client_email_status_known" CHECK ("client_email_status" IS NULL OR "client_email_status" IN ('sent', 'failed', 'not_sent')),
  CONSTRAINT "appointment_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "appointment_bookings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "appointment_bookings_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_bookings_public_id_key" ON "appointment_bookings" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_bookings_held_slot_key" ON "appointment_bookings" USING btree ("organization_id", "starts_at") WHERE "status" IN ('pending', 'confirmed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_bookings_org_starts_idx" ON "appointment_bookings" USING btree ("organization_id", "starts_at");--> statement-breakpoint

ALTER TABLE "connected_accounts" DROP CONSTRAINT IF EXISTS "connected_accounts_provider";--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_provider" CHECK ("provider" IN ('stripe', 'google', 'instagram', 'google_calendar'));
