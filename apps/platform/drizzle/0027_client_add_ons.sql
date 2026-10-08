-- Growth add-ons: a Growth feature a client has on top of their plan,
-- bought as a line on their Stripe subscription or granted by the operator.
--
-- Additive only: one new table. What a plan includes is not stored; it comes
-- from `@mortensenweb/plans`.
--
-- `when` is 1789800000000, above 0026_plans_2026_10's 1789700000000. No
-- session state between statements: production migrates over Neon's HTTP
-- driver, one statement per request.

CREATE TABLE IF NOT EXISTS "client_add_ons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
  "feature_key" text NOT NULL,
  "source" text NOT NULL,
  "stripe_subscription_item_id" text,
  "monthly_price_cents" integer,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "client_add_ons_source_known" CHECK ("source" IN ('stripe', 'operator'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_add_ons_live_key" ON "client_add_ons" USING btree ("client_id","feature_key") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_add_ons_stripe_item_idx" ON "client_add_ons" USING btree ("stripe_subscription_item_id");
