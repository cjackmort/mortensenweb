-- Daily Search Console snapshots behind the Growth tab's Search card: one row
-- per site per day holding the 28-day window as Google reported it that day
-- (totals, top 25 queries, per-day series) or the error that stopped the
-- fetch. Taken by the `searchSnapshotsTaken` cron job from the client's
-- connected Google account (0039_connected_accounts).
--
-- Additive only: one new table.
--
-- `when` is 1791200000000, above 0039 (connected accounts, 1791100000000)
-- and 0038 (user avatars, 1791000000000). The client-shop branch's 0038
-- (1790900000000) takes a later number and a higher `when` if it merges after
-- this.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

CREATE TABLE IF NOT EXISTS "search_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "site_id" uuid NOT NULL,
  "taken_on" date NOT NULL,
  "property" text,
  "data" jsonb,
  "error" text,
  "attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "fetched_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "search_snapshots_data_object" CHECK ("data" IS NULL OR jsonb_typeof("data") = 'object'),
  CONSTRAINT "search_snapshots_outcome" CHECK (("data" IS NOT NULL AND "error" IS NULL AND "fetched_at" IS NOT NULL) OR ("data" IS NULL AND "error" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "search_snapshots" ADD CONSTRAINT "search_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_snapshots" ADD CONSTRAINT "search_snapshots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_snapshots_site_day_key" ON "search_snapshots" USING btree ("site_id", "taken_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_snapshots_org_day_idx" ON "search_snapshots" USING btree ("organization_id", "taken_on");
