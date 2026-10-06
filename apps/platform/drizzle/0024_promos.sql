-- Promotions: Stripe promotion codes on checkout and on live subscriptions.
--
-- Hand-written, like 0016 onwards: `drizzle-kit generate` still refuses this
-- repository's snapshot lineage (see 0020).
--
-- `when` is 1789500000000, above 0023's 1789400000000. Drizzle's migrator
-- skips anything below the highest applied `when`, silently.
--
-- Additive only: every column is nullable, so this applies to a populated
-- database without a rewrite and rolling back is dropping columns.

-- A promo an operator attached for the client's next checkout. The code and
-- its terms are copied for display; Stripe decides the charge.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "promo_code_id" text;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "promo_code" text;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "promo_terms" text;
--> statement-breakpoint

-- A promo on a live subscription, mirrored from Stripe. `monthly_price_cents`
-- stays the list price the client returns to when the promo ends.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "discount_label" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "discounted_price_cents" integer;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "discount_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_discounted_price_non_negative"
  CHECK ("discounted_price_cents" IS NULL OR "discounted_price_cents" >= 0);
