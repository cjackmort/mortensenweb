ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "temp_password_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_lowercase" CHECK ("users"."username" IS NULL OR "users"."username" = lower("users"."username"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_temp_password_requires_expiry" CHECK ("users"."must_change_password" = false OR "users"."temp_password_expires_at" IS NOT NULL);