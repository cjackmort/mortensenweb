-- The leads inbox: contact-form submissions from client sites, in the portal.
--
-- Additive only — a new enum, a new table, two nullable columns on `sites`.
-- Code already deployed runs unchanged against this schema.
--
-- `when` is 1789450000000: above 0023's 1789400000000, and deliberately
-- *below* 1789500000000, which 0024_promos (in flight on another branch)
-- already uses. Drizzle's migrator skips anything below the highest applied
-- `when`, silently, so this one must reach production first — and sitting
-- below promos is what lets promos merge afterwards unchanged. Both files are
-- numbered 0024 because both were written against 0023; the number is a
-- label, and `when` is what orders them.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

DO $$ BEGIN
  CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'won', 'lost', 'archived');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "forms_hook_id" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "forms_connected_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "provider" text DEFAULT 'netlify' NOT NULL,
  "provider_submission_id" text NOT NULL,
  "form_name" text,
  "name" text,
  "email" text,
  "phone" text,
  "message" text,
  "fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "page_url" text,
  "status" "lead_status" DEFAULT 'new' NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "read_at" timestamp with time zone,
  "status_changed_at" timestamp with time zone,
  "notified_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "leads_fields_array" CHECK (jsonb_typeof("fields") = 'array')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_public_id_key" ON "leads" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_provider_submission_key" ON "leads" USING btree ("provider","provider_submission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_received_idx" ON "leads" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_status_idx" ON "leads" USING btree ("organization_id","status");
