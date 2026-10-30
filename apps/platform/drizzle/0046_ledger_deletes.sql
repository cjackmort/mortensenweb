-- Deleting from the ledger, without losing what was deleted.
--
-- `payments` keeps its rule: a row is never removed. "Delete" on an income row
-- sets `status = 'void'`, which every total, the ledger, the CSV and the
-- client's billing page already leave out, and these three columns say who did
-- it, when and why. The row stays because its idempotency key is what stops a
-- Stripe resync or a redelivered webhook from writing the same payment again.
--
-- `expenses` rows are hidden rather than removed for the same reason: the
-- Stripe-fee and monthly-repeat jobs re-create any automatic row whose public
-- id is missing, so a removed row came back within the hour. A row with
-- `deleted_at` set still holds its public id, so the jobs leave it alone.
--
-- Additive only. Code already deployed never reads the columns.
--
-- `when` is 1791900000000, reserved for this migration in the 2026-10-29
-- portal batch, above 0043_client_sections (1791600000000). Hand-written, as
-- 0016 onwards are: `drizzle-kit generate` cannot run on this repository.

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "voided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "void_reason" text;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "deleted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
