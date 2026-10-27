-- A profile picture for each person who signs in.
--
-- One nullable column: the key of their picture in the avatar store
-- (`lib/storage/driver.ts`), null for none. The bytes live in storage, not
-- here; the key changes on every upload so a cached old picture is never
-- served as the new one.
--
-- Additive only. Code already deployed never reads the column.
--
-- `when` is 1791000000000. The client-shop branch (not on main as this is
-- written) holds a 0038 at 1790900000000; whichever of the two merges second
-- renumbers to 0039 and takes a `when` above the other, because Drizzle's
-- migrator skips anything at or below the highest applied `when`, silently.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_key" text;
