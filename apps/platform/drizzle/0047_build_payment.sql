-- The website build as its own paid fact (roadmap P1.3, decision D1).
--
-- Until now "the build is paid" was inferred from any payment above $0: a $25
-- plan unlocked change requests while the $500 build was still owed, and a
-- 100%-off build code paid $0, unlocked nothing, and asked for $500 again.
-- From here the build is paid when its own line is paid — or an operator
-- marks its invoice paid — and that moment is recorded once, on the client.
--
-- `clients.build_paid_at` is the gate: go-live and domain connection refuse
-- while it is null (unless the client is complimentary, internal, or their
-- build was waived), and change requests unlock on it rather than on any
-- payment. A column with an audit row beside it, for the same reason as the
-- unlock timestamps: "who marked this paid, and when" needs one answer.
--
-- `payment_purpose` gains `build`, so an invoice for the build can say so —
-- one the welcome checkout raises, or one an operator raises by hand — and
-- paying it is what marks the build paid. Nothing below uses the new value:
-- Postgres refuses a value added in the same transaction, and the PGlite
-- migrator runs every pending migration in one.
--
-- ## Carried over
--
-- Every client already unlocked has `build_paid_at` set to their unlock time,
-- with a `build.paid` audit row naming this migration as the source. Under the
-- old rule "unlocked" was what "paid for the site" meant — the welcome page
-- and Get started both read it that way — so this keeps every existing client
-- seeing exactly what they saw yesterday. An unlock that came from a plan-only
-- payment is carried over too; the audit rows (`metadata->>'source' =
-- 'migration_0047'`) are the list to review.
--
-- Re-runnable: the enum value and column are IF NOT EXISTS, the audit insert
-- skips a client that already has one, and the update only fills nulls.
--
-- `when` is 1792000000000, assigned to this migration in the 2026-10-30
-- batch, above 0046_ledger_deletes (1791900000000). Drizzle's migrator skips
-- anything at or below the highest applied `when`, so this must stay the
-- highest until it has run in production.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

ALTER TYPE "public"."payment_purpose" ADD VALUE IF NOT EXISTS 'build';
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "build_paid_at" timestamp with time zone;
--> statement-breakpoint
INSERT INTO "audit_log" ("organization_id", "action", "entity_type", "entity_id", "metadata")
SELECT
  c."organization_id",
  'build.paid',
  'client',
  c."public_id",
  jsonb_build_object(
    'source', 'migration_0047',
    'basis', 'change_requests_unlocked_at',
    'at', c."change_requests_unlocked_at"
  )
FROM "clients" c
WHERE c."build_paid_at" IS NULL
  AND c."change_requests_unlocked_at" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "audit_log" a
    WHERE a."action" = 'build.paid'
      AND a."entity_type" = 'client'
      AND a."entity_id" = c."public_id"
  );
--> statement-breakpoint
UPDATE "clients"
SET "build_paid_at" = "change_requests_unlocked_at"
WHERE "build_paid_at" IS NULL
  AND "change_requests_unlocked_at" IS NOT NULL;
