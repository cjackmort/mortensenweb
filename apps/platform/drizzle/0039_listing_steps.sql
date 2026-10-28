-- Get listed: a per-site checklist of the directories a business has to be in
-- once its website is live — Google Business Profile, Search Console, Bing,
-- Apple, Yelp, BBB, Nextdoor, Facebook. One row per site and step, written
-- the first time anyone marks that step; no row means not done.
--
-- Additive only: one new table. Code already deployed runs unchanged.
--
-- `when` is 1791200000000, above every open pull request on 2026-10-27:
-- 0038_client_shop on main is 1790900000000, #156's 0038_user_avatar is
-- 1791000000000, #157's 0039_connected_accounts is 1791100000000, and the
-- review-suppression branch's 0039 is 1791000000000. Drizzle's migrator skips
-- anything below the highest applied `when`, silently, so whichever of those
-- merges after this one must raise its own above 1791200000000 first.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "listing_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "step_key" text NOT NULL,
  "state" text DEFAULT 'todo' NOT NULL,
  "note" text,
  "marked_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "marked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "listing_steps_step_known" CHECK ("step_key" IN ('google_business_profile', 'search_console', 'bing_webmaster', 'apple_business_connect', 'yelp', 'bbb', 'nextdoor', 'facebook')),
  CONSTRAINT "listing_steps_state_known" CHECK ("state" IN ('todo', 'done')),
  CONSTRAINT "listing_steps_note_short" CHECK ("note" IS NULL OR length("note") <= 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listing_steps_site_step_key" ON "listing_steps" USING btree ("site_id","step_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_steps_org_idx" ON "listing_steps" USING btree ("organization_id");
