-- Replies a client sends to a lead from the portal.
--
-- Additive only: one new table. Code already deployed runs unchanged.
--
-- `when` is 1789600000000, above 0024_promos' 1789500000000 — the highest
-- applied in production. Drizzle's migrator skips anything below that,
-- silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

CREATE TABLE IF NOT EXISTS "lead_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE cascade,
  "sent_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "body" text NOT NULL,
  "reply_to" text NOT NULL,
  "status" text NOT NULL,
  "provider_message_id" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lead_replies_status_known" CHECK ("status" IN ('sent', 'failed', 'not_sent'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_replies_public_id_key" ON "lead_replies" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_replies_lead_idx" ON "lead_replies" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_replies_org_created_idx" ON "lead_replies" USING btree ("organization_id","created_at");
