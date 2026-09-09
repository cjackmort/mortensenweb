-- Stripe subscription billing.
--
-- Hand-written rather than generated, for the same reason as 0016–0018:
-- `drizzle-kit generate` refuses to run on this repository because
-- `0014_square_venom` and `0015_internal_client_flag` were both generated from
-- the 0013 snapshot on separate branches and then merged, so two snapshots
-- claim the same parent. Repairing that lineage is its own change and touches
-- migration state two other branches are also building on; it is not folded
-- into a billing migration.
--
-- ## Why 0020 and not 0019
--
-- `feat/media-library` also wrote an 0019 (`0019_media_library`). The clash
-- that matters is not the filename — it is the journal's `when`, which is the
-- only thing Drizzle's migrator actually reads:
--
--     order by created_at desc limit 1
--     if (!last || Number(last.created_at) < migration.folderMillis) { apply }
--
-- One high-water mark, no tag comparison, no hash comparison. A migration
-- whose `when` is below the highest already applied is skipped **silently and
-- permanently** — CI reports success and the columns never appear.
--
-- This migration originally carried `when: 1788899600000`, below the media
-- library's `1789000000000`. Reproduced against real Postgres: merging media
-- first and this second left `clients.stripe_customer_id` missing with no
-- error anywhere. It is now `1789100000000`, above media's, so it applies
-- whether or not media has already moved the mark.
--
-- That fixes this direction only. If this branch is ever merged *before* the
-- media library, the media migration becomes the one below the mark and is
-- skipped instead. The rule is general and belongs to whoever merges second:
-- **check the journal's highest `when` on main and set yours above it.**
-- Merging both through one integration branch, so a single migrate run applies
-- them together, avoids the question entirely and is the preferred route.
--
-- Safe to renumber because it had never been applied anywhere: not on `main`,
-- so CI never ran it against Neon, and this worktree has no `.pglite` — the
-- only databases it ever touched were the in-memory ones the tests create and
-- discard.
--
-- Additive only. Every column is nullable or carries a default, so this
-- applies to a populated database without a lock-heavy rewrite and without a
-- backfill, and rolling it back is dropping columns nothing else reads.
--
-- Deliberately absent: any column duplicating what already exists.
-- `payments.provider` / `provider_reference` were added in an earlier
-- migration and commented "Reserved for Stripe", and
-- `subscriptions.provider` / `provider_subscription_id` already hold the
-- processor's identifiers. Stripe uses those rather than a parallel set of
-- `stripe_*` columns, which is what keeps Square, Stripe and manual records
-- from colliding: the processor is named in a column, not implied by which
-- column is populated.

-- The client's Stripe customer. Unique so a customer maps to exactly one
-- tenant — the webhook's match depends on that being single-valued. NULLs are
-- distinct in Postgres unique indexes, so the many clients without one are
-- unaffected.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_stripe_customer_key"
  ON "clients" ("stripe_customer_id");
--> statement-breakpoint

-- Which Stripe price a plan is sold at, by lookup key rather than price id:
-- price ids differ between the sandbox and the live account, so a stored id
-- would make this row wrong in one of the two environments.
ALTER TABLE "service_plans"
  ADD COLUMN IF NOT EXISTS "stripe_price_lookup_key" text;
--> statement-breakpoint

-- Processor state mirrored onto the local subscription.
--
-- `provider_status` keeps Stripe's own word, because `subscriptions.status`
-- has three values and Stripe has eight; collapsing `past_due` into `active`
-- is right for revenue rollups and useless to a billing page that has to say
-- "your card was declined".
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_status" text;
--> statement-breakpoint
-- Paid-through. Mirrored, never computed: only Stripe knows about the
-- proration, the coupon, or the failed retry that moved this date.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "current_period_end" timestamp with time zone;
--> statement-breakpoint
-- Cancelled, but still inside the period they paid for. Distinct from
-- `status = 'cancelled'`: this client keeps every entitlement they bought.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Every webhook arrives keyed by the processor's subscription id and must find
-- this row before it can act. Unique per (provider, id) so a Stripe id and a
-- Square id can never match the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_provider_key"
  ON "subscriptions" ("provider", "provider_subscription_id");
--> statement-breakpoint

-- The hosted receipt for a payment, stored at write time. A payment history
-- that calls Stripe once per row to render is slow on a good day and blank on
-- a bad one.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "receipt_url" text;
--> statement-breakpoint

-- Point the sellable plans at their prices. `comp-unlimited` is deliberately
-- excluded and must stay excluded: a complimentary plan with a price attached
-- is a plan a comp client could be put through checkout on.
UPDATE "service_plans" SET "stripe_price_lookup_key" = 'care_lite_monthly_v1'
  WHERE "key" = 'care-lite';
--> statement-breakpoint
UPDATE "service_plans" SET "stripe_price_lookup_key" = 'care_basic_monthly_v1'
  WHERE "key" = 'care-basic';
--> statement-breakpoint
UPDATE "service_plans" SET "stripe_price_lookup_key" = 'care_plus_monthly_v1'
  WHERE "key" = 'care-plus';
--> statement-breakpoint
UPDATE "service_plans" SET "stripe_price_lookup_key" = 'care_unlimited_monthly_v1'
  WHERE "key" = 'care-unlimited';
