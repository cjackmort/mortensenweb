-- Attaches the agency's own site to the pipeline it builds for everyone else.
--
-- scripts/link-internal-site.ts does the same three inserts, but only ever
-- ran against local dev -- there is no way to hand it a production
-- connection string without a human copying one to this machine, which is
-- exactly the kind of credential handling this codebase avoids everywhere
-- else. A migration reaches production through the same path every other
-- schema and data change already does: CI, with its own scoped access.
--
-- The agency organization (kind = 'agency') is created by scripts/seed.ts
-- when a database is first set up -- including production, at initial
-- deploy -- so this migration only ever references it, never creates it.
--
-- `allowlisted` is left at its default (false) deliberately: connecting the
-- repository is not the same decision as letting a webhook dispatch an
-- unattended agent against it. That switch stays the operator's, made later
-- through the same repository-connect panel every client's page uses.
--
-- Idempotent, but not by ON CONFLICT: `clients` has a unique (organization_id)
-- index to key off, but `sites` and `repository_connections` don't -- an
-- organization can hold more than one site in general, so "insert this site
-- only if this org doesn't already have one" has to be spelled out with
-- WHERE NOT EXISTS rather than relied on as a constraint.
--
-- The repository_connections insert additionally skips if `cjackmort/
-- mortensenweb` is already connected to *any* site -- `(owner, name)` is
-- globally unique, one repository can only ever back one site, and this
-- migration has no way to know from here whether an existing connection is
-- a real, intentional one worth leaving alone or stray test data worth
-- reassigning. Either way, guessing wrong and stealing someone else's
-- connection is worse than leaving the new site without one -- that just
-- shows "not connected," which is honest and easily fixed by hand through
-- the same repository-connect panel every client's page already has.

INSERT INTO "clients" ("public_id", "organization_id", "onboarding_status", "is_internal")
SELECT
  '6E3HP1JJ60W38AB37PBPQ8YS7C',
  "id",
  'active',
  true
FROM "organizations"
WHERE "kind" = 'agency'
ON CONFLICT ("organization_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "sites" ("public_id", "organization_id", "name", "primary_domain", "status")
SELECT
  'VCYEYYXZCYNZM77MJ5627XPCNM',
  "o"."id",
  'Portal',
  'portal.mortensenweb.com',
  'live'
FROM "organizations" "o"
WHERE "o"."kind" = 'agency'
  AND NOT EXISTS (
    SELECT 1 FROM "sites" WHERE "organization_id" = "o"."id"
  );
--> statement-breakpoint

INSERT INTO "repository_connections" ("public_id", "site_id", "owner", "name", "default_branch")
SELECT
  '4R6G9GZKBDK420MR2J5599YERM',
  "s"."id",
  'cjackmort',
  'mortensenweb',
  'main'
FROM "sites" "s"
INNER JOIN "organizations" "o" ON "o"."id" = "s"."organization_id"
WHERE "o"."kind" = 'agency'
  AND "s"."primary_domain" = 'portal.mortensenweb.com'
  AND NOT EXISTS (
    SELECT 1 FROM "repository_connections" WHERE "site_id" = "s"."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "repository_connections"
    WHERE "owner" = 'cjackmort' AND "name" = 'mortensenweb'
  );
