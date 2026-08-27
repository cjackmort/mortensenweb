ALTER TABLE "agent_jobs" ADD COLUMN "operator_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "operator_released_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_operator_released_by_users_id_fk" FOREIGN KEY ("operator_released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;