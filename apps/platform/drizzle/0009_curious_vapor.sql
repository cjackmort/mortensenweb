ALTER TABLE "clients" ADD COLUMN "comp_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "comp_note" text;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_comp_plan_id_service_plans_id_fk" FOREIGN KEY ("comp_plan_id") REFERENCES "public"."service_plans"("id") ON DELETE set null ON UPDATE no action;