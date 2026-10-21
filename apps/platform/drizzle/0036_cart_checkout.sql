-- Cart checkout and onboarding: what a new client pays for their website,
-- whether they have, how far the operator has taken them, and add-ons that
-- end at the close of a paid period instead of at once.
--
-- Additive only: six nullable columns. Code already deployed runs unchanged.
--
-- `when` is 1790700000000, above every migration on main and every sibling
-- migration in flight (0029-0035, up to 1790600000000). Drizzle's migrator
-- skips anything below the highest applied `when`, silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request. The check rides on the
-- ADD COLUMN so a re-run skips both together.

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "build_key" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "build_price_cents" integer CONSTRAINT "clients_build_price_non_negative" CHECK ("build_price_cents" IS NULL OR "build_price_cents" >= 0);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "build_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "demo_url" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "demo_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_add_ons" ADD COLUMN IF NOT EXISTS "cancels_at" timestamp with time zone;
