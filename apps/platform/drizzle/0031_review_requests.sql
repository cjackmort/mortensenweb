-- Review requests: a business asks a customer for a Google review, with one
-- automatic reminder, a tracked link, and a per-business suppression list.
--
-- Additive only: three new tables. Code already deployed runs unchanged.
--
-- `when` is 1790200000000, assigned to this migration among the Growth
-- features built side by side (0029 ads … 0035 monthly report). Drizzle's
-- migrator skips anything below the highest `when` already applied, silently,
-- so whoever merges after a higher-numbered sibling must raise theirs.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "review_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "review_url" text NOT NULL,
  "place_id" text,
  "place_name" text,
  "email_subject" text,
  "email_body" text,
  "reminder_body" text,
  "reminder_days" integer DEFAULT 3 NOT NULL,
  "reminders_enabled" boolean DEFAULT true NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_settings_reminder_days_range" CHECK ("reminder_days" BETWEEN 1 AND 14)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_settings_org_key" ON "review_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE set null,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "customer_name" text NOT NULL,
  "email" text,
  "phone" text,
  "sms_consent_at" timestamp with time zone,
  "sms_consent_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "from_name" text NOT NULL,
  "reply_to" text,
  "email_status" text,
  "sms_status" text,
  "sent_at" timestamp with time zone,
  "reminder_due_at" timestamp with time zone,
  "reminded_at" timestamp with time zone,
  "reminder_status" text,
  "first_clicked_at" timestamp with time zone,
  "last_clicked_at" timestamp with time zone,
  "click_count" integer DEFAULT 0 NOT NULL,
  "unsubscribed_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_requests_has_recipient" CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL),
  CONSTRAINT "review_requests_sms_needs_consent" CHECK ("sms_status" IS NULL OR "sms_consent_at" IS NOT NULL),
  CONSTRAINT "review_requests_email_status_known" CHECK ("email_status" IS NULL OR "email_status" IN ('sent', 'failed', 'not_sent', 'suppressed')),
  CONSTRAINT "review_requests_sms_status_known" CHECK ("sms_status" IS NULL OR "sms_status" IN ('sent', 'failed', 'not_sent', 'suppressed')),
  CONSTRAINT "review_requests_reminder_status_known" CHECK ("reminder_status" IS NULL OR "reminder_status" IN ('sending', 'sent', 'failed', 'not_sent', 'suppressed')),
  CONSTRAINT "review_requests_reminder_claimed" CHECK (("reminded_at" IS NULL) = ("reminder_status" IS NULL)),
  CONSTRAINT "review_requests_click_count_positive" CHECK ("click_count" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_requests_public_id_key" ON "review_requests" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_org_created_idx" ON "review_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_org_email_idx" ON "review_requests" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_org_phone_idx" ON "review_requests" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_reminder_due_idx" ON "review_requests" USING btree ("reminder_due_at") WHERE "reminder_due_at" IS NOT NULL AND "reminded_at" IS NULL AND "first_clicked_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_suppressions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "channel" text NOT NULL,
  "address" text NOT NULL,
  "reason" text NOT NULL,
  "request_id" uuid REFERENCES "review_requests"("id") ON DELETE set null,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_suppressions_channel_known" CHECK ("channel" IN ('email', 'sms')),
  CONSTRAINT "review_suppressions_reason_known" CHECK ("reason" IN ('unsubscribed', 'sms_opt_out', 'manual'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_suppressions_org_address_key" ON "review_suppressions" USING btree ("organization_id","channel","address");
