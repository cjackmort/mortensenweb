DO $$ BEGIN
 CREATE TYPE "public"."site_preview_mode" AS ENUM('screenshot', 'live');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "preview_mode" "site_preview_mode" DEFAULT 'screenshot' NOT NULL;
