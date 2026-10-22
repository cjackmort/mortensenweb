-- Job showcase: a finished job's photos and a few words, turned into a page on
-- the client's site, a Google post and social graphics.
--
-- Additive only: two new tables. Code already deployed runs unchanged.
--
-- `when` is 1790400000000, assigned to this feature among the migrations
-- written in parallel on 2026-10-14 (0028 to 0035). Whichever of them merges
-- after one with a higher `when` must raise its own above the highest on
-- `main` first, or Drizzle's migrator skips it silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "showcases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid REFERENCES "sites"("id") ON DELETE set null,
  "job" text NOT NULL,
  "town" text NOT NULL,
  "notes" text,
  "title" text NOT NULL,
  "write_up" text NOT NULL,
  "caption" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "approved_at" timestamp with time zone,
  "approved_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "site_request_id" uuid REFERENCES "change_requests"("id") ON DELETE set null,
  "site_blocked_reason" text,
  "google_status" text,
  "google_post_name" text,
  "google_posted_at" timestamp with time zone,
  "google_error" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "showcases_status_known" CHECK ("status" IN ('draft', 'approved')),
  CONSTRAINT "showcases_approved_stamped" CHECK ("status" <> 'approved' OR "approved_at" IS NOT NULL),
  CONSTRAINT "showcases_google_status_known" CHECK ("google_status" IS NULL OR "google_status" IN ('manual', 'posted', 'failed')),
  CONSTRAINT "showcases_site_blocked_known" CHECK ("site_blocked_reason" IS NULL OR "site_blocked_reason" IN ('no_site', 'locked', 'one_at_a_time', 'allowance_exhausted', 'photos_not_ready', 'failed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcases_public_id_key" ON "showcases" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "showcases_org_created_idx" ON "showcases" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "showcases_site_request_idx" ON "showcases" USING btree ("site_request_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "showcase_photos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "showcase_id" uuid NOT NULL REFERENCES "showcases"("id") ON DELETE cascade,
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "position" integer DEFAULT 0 NOT NULL,
  "role" text DEFAULT 'photo' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "showcase_photos_role_known" CHECK ("role" IN ('photo', 'before', 'after'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_photos_showcase_asset_key" ON "showcase_photos" USING btree ("showcase_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_photos_pair_role_key" ON "showcase_photos" USING btree ("showcase_id","role") WHERE "role" IN ('before', 'after');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "showcase_photos_asset_idx" ON "showcase_photos" USING btree ("asset_id");
