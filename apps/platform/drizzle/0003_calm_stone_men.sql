CREATE TYPE "public"."dunning_stage" AS ENUM('none', 'first_reminder', 'second_reminder', 'final_notice', 'management_paused');--> statement-breakpoint
CREATE TYPE "public"."management_state" AS ENUM('managed', 'at_risk', 'unmanaged');--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "management_state" "management_state" DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "management_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "management_paused_reason" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "dunning_exempt_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "dunning_stage" "dunning_stage" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "last_reminder_at" timestamp with time zone;