-- Event bookings: a client's decision on a performer's booking request, and
-- the approved ones a site lists as its upcoming events. `held` is a date and
-- time saved to the client's calendar while they agree it with the band: not
-- on the site, nobody emailed.
--
-- Additive only — one new table. Code already deployed runs unchanged.
--
-- `when` is 1789900000000, above 0027_client_add_ons' 1789800000000 — the
-- highest on main. Drizzle's migrator skips anything below the highest
-- applied `when`, silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

CREATE TABLE IF NOT EXISTS "event_bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE set null,
  "decision" text NOT NULL,
  "act_name" text NOT NULL,
  "genre" text,
  "event_date" date,
  "start_time" text,
  "is_ticketed" boolean DEFAULT false NOT NULL,
  "logo_key" text,
  "logo_content_type" text,
  "contact_email" text,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "email_status" text,
  "email_error" text,
  "removed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "event_bookings_decision_known" CHECK ("decision" IN ('held', 'approved', 'declined')),
  CONSTRAINT "event_bookings_scheduled_has_date" CHECK ("decision" = 'declined' OR "event_date" IS NOT NULL),
  CONSTRAINT "event_bookings_start_time_shape" CHECK ("start_time" IS NULL OR "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "event_bookings_email_status_known" CHECK ("email_status" IS NULL OR "email_status" IN ('sent', 'failed', 'not_sent'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_bookings_public_id_key" ON "event_bookings" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_bookings_lead_key" ON "event_bookings" USING btree ("lead_id") WHERE "lead_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_bookings_site_date_idx" ON "event_bookings" USING btree ("site_id","event_date");
