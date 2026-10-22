-- Archiving a lead stops overwriting what the client marked it.
--
-- Until now the inbox archived an enquiry by setting `status` to `archived`:
-- by hand since the inbox launched (2026-10-06), and on its own since #109's
-- ten-lead trim (merged 2026-10-20) archived whatever fell past the newest
-- ten. Either way a lead marked won stopped being won, and everything that
-- counts won enquiries lost it. `archived_at` now says whether the lead is in
-- the inbox, and `status` goes back to saying only where it stands.
--
-- The backfill copies the one fact those rows still hold — that they were
-- archived, and when — and nothing else. What their status was before is not
-- stored anywhere, so they keep `archived`, which the code reads as "not
-- recorded". Archiving was their last status change, so `status_changed_at`
-- is when it happened; `updated_at` covers a row without one.
--
-- Additive only: one nullable column and a backfill of it. Code already
-- deployed ignores the column and keeps writing `archived`. Anything it
-- archives between this migration and the code that reads the column shows
-- in the inbox again until the UPDATE below is run once more; it is
-- idempotent, and matches nothing once the new code is live.
--
-- `when` is 1790800000000, assigned to 0037 up front alongside 0029–0036
-- (1790000000000–1790700000000), none of which is on main yet. Drizzle's
-- migrator skips anything below the highest applied `when`, silently, so
-- this merges after them, or each of them raises its `when` above this one
-- before merging.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
UPDATE "leads"
SET "archived_at" = coalesce("status_changed_at", "updated_at")
WHERE "status" = 'archived' AND "archived_at" IS NULL;
