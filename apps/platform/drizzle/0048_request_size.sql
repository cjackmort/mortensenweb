-- How big a change request is: small or big (decision D7).
--
-- Small is wording, prices, hours, contact details, swapping a photo. Big is
-- new pages, new sections, layout or design, or feature work. A client whose
-- website build is not paid and who has no paid plan gets one small change a
-- month and no big ones; everyone else keeps their plan's rules. So the size
-- decides what a request may be, and it has to be stored on the request: the
-- client picks it when they submit, an operator can reclassify it, and the
-- agent is told it and hands a "small" request back if the work is big.
--
-- Its own column rather than a reuse of `category`. Category is what kind of
-- change it is, no longer asked of the client and `other` on every row; size
-- is how much work it is. Folding one into the other would make both
-- unanswerable.
--
-- A new enum, created here, so nothing depends on adding a value to an
-- existing one. The column is nullable and nothing is backfilled: NULL means
-- the request was submitted before D7, and no rule reads a size it was never
-- given.
--
-- Additive and re-runnable statement by statement, as Neon's HTTP migrator
-- applies it: the type is created only if missing, the column IF NOT EXISTS.
-- Code already deployed never reads the column.
--
-- `when` is 1792100000000, assigned to this migration in the 2026-10-30
-- batch, above 0047_build_payment (1792000000000). Drizzle's migrator skips
-- anything at or below the highest applied `when`, so this must stay the
-- highest until it has run in production.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

DO $$ BEGIN
  CREATE TYPE "public"."request_size" AS ENUM ('small', 'big');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN IF NOT EXISTS "size" "public"."request_size";
