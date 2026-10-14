-- Win-back emails: past customers, the campaigns written to them, who each
-- one went to, and the addresses that must never be emailed again.
--
-- Additive only: four new tables. Code already deployed runs unchanged.
--
-- `when` is 1790300000000. Migrations 0028-0031 are in flight on other
-- branches with lower marks; Drizzle's migrator skips anything below the
-- highest applied `when`, silently, so whichever of those merges after this
-- one must raise its own `when` above this before merging.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on
-- this repository. No session state between statements: production migrates
-- over Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "winback_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "email" text NOT NULL,
  "name" text,
  "source" text NOT NULL,
  "lead_id" uuid REFERENCES "leads"("id") ON DELETE set null,
  "how_became_customer" text NOT NULL,
  "last_job_on" date,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "winback_contacts_source_known" CHECK ("source" IN ('lead', 'import', 'manual'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winback_contacts_public_id_key" ON "winback_contacts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winback_contacts_org_email_key" ON "winback_contacts" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_contacts_org_created_idx" ON "winback_contacts" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "winback_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "occasion_key" text NOT NULL,
  "name" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "offer" text,
  "offer_expires_on" date,
  "status" text DEFAULT 'draft' NOT NULL,
  "scheduled_for" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "approved_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "from_name" text,
  "reply_to" text,
  "postal_address" text,
  "send_started_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "halted_at" timestamp with time zone,
  "halted_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "halt_reason" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "winback_campaigns_status_known" CHECK ("status" IN ('draft', 'approved', 'sending', 'sent', 'cancelled', 'halted'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winback_campaigns_public_id_key" ON "winback_campaigns" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_campaigns_org_created_idx" ON "winback_campaigns" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_campaigns_status_scheduled_idx" ON "winback_campaigns" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "winback_suppressions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "email" text NOT NULL,
  "reason" text NOT NULL,
  "campaign_id" uuid REFERENCES "winback_campaigns"("id") ON DELETE set null,
  "ip_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "winback_suppressions_reason_known" CHECK ("reason" IN ('unsubscribed', 'bounced', 'complained', 'manual'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winback_suppressions_org_email_key" ON "winback_suppressions" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_suppressions_ip_created_idx" ON "winback_suppressions" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "winback_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "winback_campaigns"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "contact_id" uuid REFERENCES "winback_contacts"("id") ON DELETE set null,
  "email" text NOT NULL,
  "name" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "claimed_at" timestamp with time zone,
  "provider_message_id" text,
  "error" text,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "opened_at" timestamp with time zone,
  "clicked_at" timestamp with time zone,
  "bounced_at" timestamp with time zone,
  "complained_at" timestamp with time zone,
  "unsubscribed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "winback_recipients_status_known" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'suppressed', 'not_sent', 'halted'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winback_recipients_public_id_key" ON "winback_recipients" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winback_recipients_campaign_email_key" ON "winback_recipients" USING btree ("campaign_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_recipients_campaign_status_idx" ON "winback_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_recipients_provider_message_idx" ON "winback_recipients" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winback_recipients_org_idx" ON "winback_recipients" USING btree ("organization_id");
