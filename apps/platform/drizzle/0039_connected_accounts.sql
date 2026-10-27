-- Accounts a client connects for the portal to look over: Stripe, Google
-- Search Console, Instagram. One live row per client and provider; a
-- disconnect keeps the row as history with its tokens cleared. Tokens are
-- sealed before they are written (lib/connections/seal.ts). The last audit
-- is stored as JSON so the monthly report and the Connections page read the
-- same findings.
--
-- Additive only: one new table.
--
-- `when` is 1791100000000, above 0038 (user avatars, 1791000000000). The
-- client-shop branch's 0038 (1790900000000) takes 0040 and a higher `when`
-- if it merges after this.
--
-- Hand-written, as 0016 onwards are: `drizzle-kit generate` cannot run on this
-- repository.

CREATE TABLE IF NOT EXISTS "connected_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "display_name" text,
  "scope" text DEFAULT '' NOT NULL,
  "access_token_sealed" text,
  "refresh_token_sealed" text,
  "token_expires_at" timestamp with time zone,
  "status" text DEFAULT 'connected' NOT NULL,
  "connected_by" uuid,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_audit" jsonb,
  "last_audit_at" timestamp with time zone,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connected_accounts_provider" CHECK ("provider" IN ('stripe', 'google', 'instagram')),
  CONSTRAINT "connected_accounts_status" CHECK ("status" IN ('connected', 'needs_reconnect', 'revoked')),
  CONSTRAINT "connected_accounts_audit_object" CHECK ("last_audit" IS NULL OR jsonb_typeof("last_audit") = 'object')
);--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connected_accounts_public_id_key" ON "connected_accounts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connected_accounts_live_key" ON "connected_accounts" USING btree ("organization_id", "provider") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connected_accounts_audit_due_idx" ON "connected_accounts" USING btree ("status", "last_audit_at");
