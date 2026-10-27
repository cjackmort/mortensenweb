-- A profile picture for each person who signs in.
--
-- One nullable column: the key of their picture in the avatar store
-- (`lib/storage/driver.ts`), null for none. The bytes live in storage, not
-- here; the key changes on every upload so a cached old picture is never
-- served as the new one.
--
-- Additive only. Code already deployed never reads the column.
--
-- `when` is 1791300000000, above every open pull request on 2026-10-27:
-- 0038_client_shop on main is 1790900000000 and the Get listed branch's
-- 0039_listing_steps (#159) is 1791200000000. Numbered 0040 so the two can
-- merge in either order without renaming, but Drizzle's migrator skips
-- anything at or below the highest applied `when`, silently: if this merges
-- before #159, that one must raise its `when` above 1791300000000 first.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_key" text;
