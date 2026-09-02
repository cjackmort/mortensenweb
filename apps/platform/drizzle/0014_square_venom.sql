CREATE TYPE "public"."ledger_category" AS ENUM('software', 'hosting', 'contractor', 'marketing', 'equipment', 'fees', 'other');--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"description" text NOT NULL,
	"category" "ledger_category" DEFAULT 'other' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"occurred_on" date NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"note" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_positive" CHECK ("expenses"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_public_id_key" ON "expenses" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "expenses_occurred_idx" ON "expenses" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "expenses_category_idx" ON "expenses" USING btree ("category");