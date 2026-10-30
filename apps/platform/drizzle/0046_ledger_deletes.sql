-- Deleting from the ledger without losing what was deleted, and valuing free
-- builds for the write-offs list.
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
-- For "Potential write-offs" on the same page: a site the agency built for
-- free, valued at what it would normally charge (`clients.free_build_value_cents`)
-- and when (`free_build_on`). Both set or both null. Not money: it never
-- reaches the ledger or any revenue total.
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
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "free_build_value_cents" integer;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "free_build_on" date;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "clients" ADD CONSTRAINT "clients_free_build_complete"
    CHECK (("free_build_value_cents" IS NULL) = ("free_build_on" IS NULL)
      AND ("free_build_value_cents" IS NULL OR "free_build_value_cents" > 0));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
