-- What kind of site a client has, chosen by the operator when adding them.
--
-- `booking_enabled` opens "Set your availability" in their portal;
-- `shop_enabled` opens the online shop. Both default to false, so every
-- existing client keeps exactly the portal they have today.
--
-- Additive only. Code already deployed never reads the columns.
--
-- `when` is 1791600000000, above 0042_search_snapshots (1791500000000), the
-- production high-water mark on 2026-10-29. Hand-written, as 0016 onwards
-- are: `drizzle-kit generate` cannot run on this repository.

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "booking_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "shop_enabled" boolean DEFAULT false NOT NULL;
