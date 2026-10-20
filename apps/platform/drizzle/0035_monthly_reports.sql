-- Monthly reports: one per client organization per calendar month, kept as
-- the snapshot that was sent, plus a per-client switch for the email.
--
-- Additive only: two new tables. Code already deployed runs unchanged.
--
-- `when` is 1790600000000, above every migration on main and every sibling
-- migration in flight (0028-0034). Drizzle's migrator skips anything below
-- the highest applied `when`, silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "monthly_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "period" text NOT NULL,
  "data" jsonb NOT NULL,
  "built_at" timestamp with time zone DEFAULT now() NOT NULL,
  "email_status" text,
  "emailed_at" timestamp with time zone,
  "email_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "monthly_reports_period_format" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "monthly_reports_data_object" CHECK (jsonb_typeof("data") = 'object'),
  CONSTRAINT "monthly_reports_email_status_known" CHECK ("email_status" IS NULL OR "email_status" IN ('sent', 'skipped', 'failed', 'opted_out', 'no_recipient'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_reports_org_period_key" ON "monthly_reports" USING btree ("organization_id","period");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monthly_report_preferences" (
  "organization_id" uuid PRIMARY KEY NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "emails_off_at" timestamp with time zone,
  "emails_off_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
