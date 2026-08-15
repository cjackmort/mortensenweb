CREATE TYPE "public"."payment_request_status" AS ENUM('draft', 'open', 'awaiting_confirmation', 'paid', 'overdue', 'cancelled', 'written_off');--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"subscription_id" uuid,
	"reference" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"covers_period_start" date,
	"covers_period_end" date,
	"due_on" date,
	"status" "payment_request_status" DEFAULT 'open' NOT NULL,
	"method" "payment_method",
	"initiated_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"payment_id" uuid,
	"note" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_amount_positive" CHECK ("payment_requests"."amount_cents" > 0),
	CONSTRAINT "payment_requests_paid_requires_confirmation" CHECK ("payment_requests"."status" <> 'paid' OR ("payment_requests"."confirmed_at" IS NOT NULL AND "payment_requests"."confirmed_by_user_id" IS NOT NULL)),
	CONSTRAINT "payment_requests_period_order" CHECK ("payment_requests"."covers_period_end" IS NULL OR "payment_requests"."covers_period_start" IS NULL OR "payment_requests"."covers_period_end" >= "payment_requests"."covers_period_start")
);
--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_public_id_key" ON "payment_requests" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_reference_key" ON "payment_requests" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payment_requests_client_status_idx" ON "payment_requests" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "payment_requests_due_idx" ON "payment_requests" USING btree ("due_on");