-- A repository may be connected to more than one site.
--
-- The agency's own site is the MortensenWeb tab and, for testing what a client
-- sees, also an ordinary client record: two sites, one repository. Until now
-- the database allowed each repository exactly once, on (owner, name) and on
-- repo_node_id, so the second connection could not exist.
--
-- Which sites may share is an application rule, not a database one: see
-- `connectExistingRepo`, which allows it only when one of the two is the
-- agency's own site. What stays enforced here is that one site cannot hold the
-- same repository twice.
--
-- Relaxing only. Code already deployed never inserts a second connection for
-- a repository (it refuses first), so it runs unchanged against this schema.
-- That is why this ships on its own, ahead of the code that uses it.
--
-- Hand-written, as 0016-0020 are: `drizzle-kit generate` cannot run on this
-- repository (two snapshots claim the same parent). `when` is above 0020's
-- 1789100000000, the current high-water mark.

DROP INDEX IF EXISTS "repository_connections_owner_name_key";--> statement-breakpoint
DROP INDEX IF EXISTS "repository_connections_node_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repository_connections_node_site_key" ON "repository_connections" USING btree ("repo_node_id","site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repository_connections_node_id_idx" ON "repository_connections" USING btree ("repo_node_id");
