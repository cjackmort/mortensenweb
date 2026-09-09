-- The client media library.
--
-- Hand-written, like 0016-0018, because drizzle-kit cannot generate against
-- this migration set: two snapshots (0014, 0015) point at the same parent and
-- `generate` refuses to run until that is untangled. Untangling it is a
-- separate job with its own risk, and doing it inside a feature migration
-- would mean one change that both adds tables and rewrites migration history.
--
-- Purely additive. Nothing here drops, renames or rewrites an existing column,
-- so `request_attachments` and every code path that reads it keep working
-- untouched; the media library is a second, parallel way to attach an image,
-- not a replacement for the first. That is what makes this migration safe to
-- apply ahead of the code that uses it, and what makes rolling the code back
-- possible without rolling the schema back.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
 CREATE TYPE "public"."media_asset_status" AS ENUM('uploading', 'processing', 'ready', 'failed', 'quarantined');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."media_derivative_kind" AS ENUM('thumb', 'preview', 'web_sm', 'web_md', 'web_lg');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."media_upload_status" AS ENUM('pending', 'completed', 'aborted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Folders
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "media_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "parent_id" uuid REFERENCES "media_folders"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "depth" integer DEFAULT 0 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_folders_name_not_blank" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "media_folders_depth_bounded" CHECK ("depth" >= 0 AND "depth" <= 10),
  CONSTRAINT "media_folders_path_rooted" CHECK ("path" LIKE '/%'),
  CONSTRAINT "media_folders_no_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_folders_public_id_key" ON "media_folders" ("public_id");
--> statement-breakpoint
-- Sibling uniqueness. A path encodes its parent, so one index on (org, path)
-- is also "no two children of one parent share a name". Partial, so a trashed
-- folder does not reserve its name against a client who cannot see it.
CREATE UNIQUE INDEX IF NOT EXISTS "media_folders_org_path_key" ON "media_folders" ("organization_id", "path") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_folders_org_parent_idx" ON "media_folders" ("organization_id", "parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_folders_org_path_idx" ON "media_folders" ("organization_id", "path");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "media_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "folder_id" uuid REFERENCES "media_folders"("id") ON DELETE set null,
  "status" "media_asset_status" DEFAULT 'uploading' NOT NULL,
  "storage_key" text,
  "original_filename" text NOT NULL,
  "content_type" text,
  "byte_size" bigint DEFAULT 0 NOT NULL,
  "checksum_sha256" text,
  "width" integer,
  "height" integer,
  "has_alpha" boolean,
  "orientation" integer,
  "title" text,
  "description" text,
  "uploaded_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "failure_reason" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_assets_size_nonnegative" CHECK ("byte_size" >= 0),
  CONSTRAINT "media_assets_orientation_valid" CHECK ("orientation" IS NULL OR ("orientation" >= 1 AND "orientation" <= 8)),
  -- The invariant the whole upload design reduces to: a browser reporting
  -- success cannot make an asset ready, because ready requires bytes the
  -- server has assembled and checksummed.
  CONSTRAINT "media_assets_ready_has_object" CHECK ("status" <> 'ready' OR ("storage_key" IS NOT NULL AND "checksum_sha256" IS NOT NULL AND "byte_size" > 0))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_public_id_key" ON "media_assets" ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_storage_key_key" ON "media_assets" ("storage_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_org_status_idx" ON "media_assets" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_org_folder_idx" ON "media_assets" ("organization_id", "folder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_org_created_idx" ON "media_assets" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_org_filename_idx" ON "media_assets" ("organization_id", "original_filename");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Derivatives
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "media_derivatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "kind" "media_derivative_kind" NOT NULL,
  "storage_key" text NOT NULL,
  "content_type" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "byte_size" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_derivatives_size_positive" CHECK ("byte_size" > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_derivatives_asset_kind_key" ON "media_derivatives" ("asset_id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_derivatives_storage_key_key" ON "media_derivatives" ("storage_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_derivatives_asset_idx" ON "media_derivatives" ("asset_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Upload sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "media_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "status" "media_upload_status" DEFAULT 'pending' NOT NULL,
  "declared_bytes" bigint NOT NULL,
  "declared_checksum" text NOT NULL,
  "declared_filename" text NOT NULL,
  "declared_content_type" text NOT NULL,
  "part_size" integer NOT NULL,
  "part_count" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_uploads_part_count_bounded" CHECK ("part_count" >= 1 AND "part_count" <= 2000),
  CONSTRAINT "media_uploads_part_size_positive" CHECK ("part_size" > 0),
  CONSTRAINT "media_uploads_declared_bytes_positive" CHECK ("declared_bytes" > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_uploads_public_id_key" ON "media_uploads" ("public_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_uploads_org_status_idx" ON "media_uploads" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_uploads_expiry_idx" ON "media_uploads" ("status", "expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "media_upload_parts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_id" uuid NOT NULL REFERENCES "media_uploads"("id") ON DELETE cascade,
  "part_number" integer NOT NULL,
  "storage_key" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "checksum_sha256" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_upload_parts_number_positive" CHECK ("part_number" >= 1),
  CONSTRAINT "media_upload_parts_size_positive" CHECK ("byte_size" > 0)
);
--> statement-breakpoint

-- Retrying a part re-sends the same number. This is what makes an interrupted
-- upload resumable instead of duplicating bytes into the assembled file.
CREATE UNIQUE INDEX IF NOT EXISTS "media_upload_parts_upload_number_key" ON "media_upload_parts" ("upload_id", "part_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_upload_parts_upload_idx" ON "media_upload_parts" ("upload_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Derivative jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "media_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "status" "job_status" DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_jobs_attempts_bounded" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_jobs_public_id_key" ON "media_jobs" ("public_id");
--> statement-breakpoint
-- One outstanding job per asset: two runners writing the same derivative keys
-- is the race this index removes.
CREATE UNIQUE INDEX IF NOT EXISTS "media_jobs_asset_open_key" ON "media_jobs" ("asset_id") WHERE "status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_jobs_claim_idx" ON "media_jobs" ("status", "next_attempt_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Request linkage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "request_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "change_requests"("id") ON DELETE cascade,
  -- restrict, not cascade: an asset a request depends on must not vanish
  -- underneath it. The library's delete path checks first and explains.
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE restrict,
  "position" integer DEFAULT 0 NOT NULL,
  "snapshot_checksum" text,
  "snapshot_title" text,
  "snapshot_description" text,
  "snapshot_folder_path" text,
  "snapshot_width" integer,
  "snapshot_height" integer,
  "snapshot_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "request_assets_request_asset_key" ON "request_assets" ("request_id", "asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_assets_request_idx" ON "request_assets" ("request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_assets_asset_idx" ON "request_assets" ("asset_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "media_usages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "site_id" uuid REFERENCES "sites"("id") ON DELETE set null,
  "request_id" uuid REFERENCES "change_requests"("id") ON DELETE set null,
  "location" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_usages_state_valid" CHECK ("state" IN ('pending', 'published', 'removed'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "media_usages_asset_request_key" ON "media_usages" ("asset_id", "request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_usages_asset_idx" ON "media_usages" ("asset_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Existing tables
-- ---------------------------------------------------------------------------

-- Per-client storage limit. Null means the platform default, so this column
-- being added changes nothing for anyone until an operator sets one.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "media_quota_bytes" bigint;
--> statement-breakpoint

-- Bytes spoken for, as an atomic counter.
--
-- Not derivable per request: `SUM(byte_size)` has to be read before the quota
-- decision and written after it, and simultaneous requests all read the same
-- total. Measured at ten concurrent starts against room for five, every one was
-- granted. A conditional UPDATE on this column takes a row lock and cannot be
-- split that way.
--
-- Defaults to 0 and is reconciled from the assets themselves on the scheduled
-- tick, so existing rows need no backfill here: the first reconciliation sets
-- them, and until then a client simply has their full allowance.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "media_reserved_bytes" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Makes submitting a change request idempotent. Nullable, and unique only
-- where present, so every existing row is unaffected.
ALTER TABLE "change_requests" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_org_idempotency_key" ON "change_requests" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
