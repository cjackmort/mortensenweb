CREATE TYPE "public"."billing_treatment" AS ENUM('included', 'overage', 'courtesy');--> statement-breakpoint
CREATE TYPE "public"."brief_kind" AS ENUM('discovery', 'revision');--> statement-breakpoint
CREATE TYPE "public"."brief_status" AS ENUM('draft', 'submitted', 'dispatched', 'applied', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."preview_decision" AS ENUM('pending', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."preview_kind" AS ENUM('concept', 'pull_request', 'production');--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'square' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "change_allowances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"subscription_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"included" integer,
	"used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_allowances_used_non_negative" CHECK ("change_allowances"."used" >= 0),
	CONSTRAINT "change_allowances_included_non_negative" CHECK ("change_allowances"."included" IS NULL OR "change_allowances"."included" >= 0),
	CONSTRAINT "change_allowances_period_order" CHECK ("change_allowances"."period_end" >= "change_allowances"."period_start")
);
--> statement-breakpoint
CREATE TABLE "site_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" "brief_kind" DEFAULT 'revision' NOT NULL,
	"status" "brief_status" DEFAULT 'draft' NOT NULL,
	"colour_direction" text,
	"features" text,
	"content_notes" text,
	"body" text,
	"authored_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_briefs_not_empty" CHECK (length(btrim(coalesce("site_briefs"."colour_direction", '') || coalesce("site_briefs"."features", '') || coalesce("site_briefs"."content_notes", '') || coalesce("site_briefs"."body", ''))) > 0),
	CONSTRAINT "site_briefs_submitted_complete" CHECK ("site_briefs"."status" = 'draft' OR "site_briefs"."submitted_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "preview_deployments" DROP CONSTRAINT "preview_deployments_subject_required";--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "netlify_site_id" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "netlify_site_name" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "production_url" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "dns_records" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "dns_instructions_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "live_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "analytics_unlocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "change_requests_unlocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "service_plans" ADD COLUMN "included_changes_per_month" integer;--> statement-breakpoint
ALTER TABLE "service_plans" ADD COLUMN "overage_per_change_cents" integer;--> statement-breakpoint
ALTER TABLE "service_plans" ADD COLUMN "includes_analytics" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service_plans" ADD COLUMN "square_plan_variation_id" text;--> statement-breakpoint
ALTER TABLE "service_plans" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "recurring_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "agent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "kind" "preview_kind" DEFAULT 'concept' NOT NULL;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "brief_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "preview_url" text;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "preview_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "client_decision" "preview_decision" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "client_decision_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "client_decision_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "billing" "billing_treatment" DEFAULT 'included' NOT NULL;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "allowance_id" uuid;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "payment_request_id" uuid;--> statement-breakpoint
ALTER TABLE "change_allowances" ADD CONSTRAINT "change_allowances_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_allowances" ADD CONSTRAINT "change_allowances_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_briefs" ADD CONSTRAINT "site_briefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_briefs" ADD CONSTRAINT "site_briefs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_briefs" ADD CONSTRAINT "site_briefs_authored_by_user_id_users_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_allowances_client_period_key" ON "change_allowances" USING btree ("client_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "site_briefs_public_id_key" ON "site_briefs" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "site_briefs_org_idx" ON "site_briefs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "site_briefs_status_idx" ON "site_briefs" USING btree ("status");--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_brief_id_site_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."site_briefs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_client_decision_by_user_id_users_id_fk" FOREIGN KEY ("client_decision_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_allowance_id_change_allowances_id_fk" FOREIGN KEY ("allowance_id") REFERENCES "public"."change_allowances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_payment_request_id_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_deployments_agent_job_idx" ON "preview_deployments" USING btree ("agent_job_id");--> statement-breakpoint
CREATE INDEX "agent_jobs_brief_idx" ON "agent_jobs" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "agent_jobs_repo_pr_idx" ON "agent_jobs" USING btree ("repository_connection_id","pr_number");--> statement-breakpoint
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_included_changes_non_negative" CHECK ("service_plans"."included_changes_per_month" IS NULL OR "service_plans"."included_changes_per_month" >= 0);--> statement-breakpoint
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_overage_non_negative" CHECK ("service_plans"."overage_per_change_cents" IS NULL OR "service_plans"."overage_per_change_cents" >= 0);--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_subject_required" CHECK (("preview_deployments"."concept_job_id" IS NOT NULL) OR ("preview_deployments"."site_id" IS NOT NULL) OR ("preview_deployments"."agent_job_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_decision_complete" CHECK (("agent_jobs"."client_decision" = 'pending') = ("agent_jobs"."client_decision_at" IS NULL));