-- Client shops: a client sells from their own site. The portal holds the
-- catalog and stock; checkout runs on the client's own connected Stripe
-- account; the site reads the shop live. `docs/SHOP-PLAN.md` in the agency
-- repository is the plan of record.
--
-- Additive only: six new tables. Code already deployed runs unchanged.
--
-- `when` is 1790900000000, one above 0037's 1790800000000, the highest on
-- `main` on 2026-10-27. Drizzle's migrator skips anything below the highest
-- applied `when`, silently, so anything written in parallel that merges after
-- this one must raise its own above it first.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository. No session state between statements: production migrates over
-- Neon's HTTP driver, one statement per request.

CREATE TABLE IF NOT EXISTS "shop_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "stripe_account_id" text,
  "charges_enabled" boolean DEFAULT false NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "fulfilment" text DEFAULT 'ship' NOT NULL,
  "shipping_cents" integer DEFAULT 0 NOT NULL,
  "tax_enabled" boolean DEFAULT false NOT NULL,
  "refund_policy" text,
  "shipping_policy" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_settings_currency_shape" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "shop_settings_fulfilment_known" CHECK ("fulfilment" IN ('ship', 'pickup')),
  CONSTRAINT "shop_settings_shipping_not_negative" CHECK ("shipping_cents" >= 0),
  CONSTRAINT "shop_settings_stripe_account_shape" CHECK ("stripe_account_id" IS NULL OR "stripe_account_id" ~ '^acct_[A-Za-z0-9]+$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_settings_site_key" ON "shop_settings" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_settings_org_idx" ON "shop_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "price_cents" integer NOT NULL,
  "stock" integer,
  "reserved" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'hidden' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_products_name_present" CHECK (length(trim("name")) > 0),
  CONSTRAINT "shop_products_slug_shape" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "shop_products_price_sellable" CHECK ("price_cents" >= 50),
  CONSTRAINT "shop_products_status_known" CHECK ("status" IN ('active', 'hidden')),
  CONSTRAINT "shop_products_stock_not_negative" CHECK ("stock" IS NULL OR "stock" >= 0),
  CONSTRAINT "shop_products_reserved_not_negative" CHECK ("reserved" >= 0),
  CONSTRAINT "shop_products_reserved_within_stock" CHECK ("stock" IS NULL OR "reserved" <= "stock")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_products_public_id_key" ON "shop_products" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_products_site_slug_key" ON "shop_products" USING btree ("site_id","slug") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_products_site_status_idx" ON "shop_products" USING btree ("site_id","status","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_products_org_idx" ON "shop_products" USING btree ("organization_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_product_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "shop_products"("id") ON DELETE cascade,
  "asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_product_images_position_not_negative" CHECK ("position" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_product_images_product_asset_key" ON "shop_product_images" USING btree ("product_id","asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_product_images_asset_idx" ON "shop_product_images" USING btree ("asset_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "stripe_account_id" text NOT NULL,
  "stripe_session_id" text NOT NULL,
  "stripe_payment_intent_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "fulfilment" text NOT NULL,
  "buyer_name" text,
  "buyer_email" text,
  "shipping_address" jsonb,
  "subtotal_cents" integer NOT NULL,
  "shipping_cents" integer DEFAULT 0 NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "paid_at" timestamp with time zone,
  "shipped_at" timestamp with time zone,
  "refunded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_orders_status_known" CHECK ("status" IN ('pending', 'paid', 'shipped', 'refunded', 'expired')),
  CONSTRAINT "shop_orders_fulfilment_known" CHECK ("fulfilment" IN ('ship', 'pickup')),
  CONSTRAINT "shop_orders_amounts_not_negative" CHECK ("subtotal_cents" >= 0 AND "shipping_cents" >= 0 AND "tax_cents" >= 0 AND "total_cents" >= 0),
  CONSTRAINT "shop_orders_currency_shape" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "shop_orders_paid_stamped" CHECK ("status" IN ('pending', 'expired') OR "paid_at" IS NOT NULL),
  CONSTRAINT "shop_orders_shipped_stamped" CHECK ("status" <> 'shipped' OR "shipped_at" IS NOT NULL),
  CONSTRAINT "shop_orders_refunded_stamped" CHECK ("status" <> 'refunded' OR "refunded_at" IS NOT NULL),
  CONSTRAINT "shop_orders_address_object" CHECK ("shipping_address" IS NULL OR jsonb_typeof("shipping_address") = 'object')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_orders_public_id_key" ON "shop_orders" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_orders_stripe_session_key" ON "shop_orders" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_orders_org_created_idx" ON "shop_orders" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_orders_site_status_idx" ON "shop_orders" USING btree ("site_id","status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_order_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "shop_orders"("id") ON DELETE cascade,
  "product_id" uuid REFERENCES "shop_products"("id") ON DELETE set null,
  "name" text NOT NULL,
  "unit_cents" integer NOT NULL,
  "quantity" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_order_items_unit_not_negative" CHECK ("unit_cents" >= 0),
  CONSTRAINT "shop_order_items_quantity_positive" CHECK ("quantity" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_order_items_order_idx" ON "shop_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_order_items_product_idx" ON "shop_order_items" USING btree ("product_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_product_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "shop_products"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "action" text NOT NULL,
  "changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_product_events_action_known" CHECK ("action" IN ('created', 'updated', 'activated', 'hidden', 'deleted', 'stock_reserved', 'stock_sold', 'stock_released', 'restocked')),
  CONSTRAINT "shop_product_events_changes_object" CHECK (jsonb_typeof("changes") = 'object')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_product_events_product_idx" ON "shop_product_events" USING btree ("product_id","created_at");
