CREATE TYPE "public"."actor_type" AS ENUM('client', 'admin', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "public"."adjustment_kind" AS ENUM('correction', 'refund', 'void', 'writeoff');--> statement-breakpoint
CREATE TYPE "public"."agent_job_status" AS ENUM('queued', 'dispatched', 'running', 'pr_open', 'merged', 'failed', 'timed_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('concept_plan', 'pr_merge', 'preview', 'production_launch', 'migration_scope', 'public_display');--> statement-breakpoint
CREATE TYPE "public"."concept_status" AS ENUM('draft', 'plan_pending_approval', 'approved', 'scaffolding', 'building', 'deployed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."connection_mode" AS ENUM('managed', 'connected_existing', 'transferred');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'building', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."environment_kind" AS ENUM('preview', 'production');--> statement-breakpoint
CREATE TYPE "public"."fact_source" AS ENUM('crawl', 'user_supplied', 'inferred');--> statement-breakpoint
CREATE TYPE "public"."fact_verification" AS ENUM('unverified', 'user_verified', 'conflicting', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."migration_scope" AS ENUM('read_only_audit', 'branch_changes', 'launch');--> statement-breakpoint
CREATE TYPE "public"."migration_status" AS ENUM('draft', 'awaiting_authorization', 'authorized', 'auditing', 'audited', 'in_progress', 'awaiting_launch_approval', 'launched', 'rolled_back', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."organization_kind" AS ENUM('agency', 'client');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'venmo', 'check', 'card', 'bank_transfer', 'stripe', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('recorded', 'void');--> statement-breakpoint
CREATE TYPE "public"."prospect_status" AS ENUM('new', 'auditing', 'audited', 'concept_pending', 'concept_ready', 'shared', 'converted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."readiness_status" AS ENUM('pass', 'warn', 'fail', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."repo_strategy" AS ENUM('rename_transfer', 'fresh_repo');--> statement-breakpoint
CREATE TYPE "public"."request_category" AS ENUM('content', 'design', 'bug', 'seo', 'feature', 'other');--> statement-breakpoint
CREATE TYPE "public"."request_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('submitted', 'triaged', 'approved', 'rejected', 'dispatched', 'in_progress', 'pr_open', 'changes_requested', 'merged', 'deployed', 'verified', 'closed', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'clean', 'flagged', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."site_status" AS ENUM('draft', 'preview', 'live', 'archived');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'client');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."viewport" AS ENUM('mobile', 'tablet', 'desktop');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('internal', 'client_visible');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"organization_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"target_user_id" uuid,
	"target_organization_id" uuid NOT NULL,
	"reason" text,
	"ip_hash" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"ip_hash" text,
	"succeeded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "organization_kind" DEFAULT 'client' NOT NULL,
	"timezone" text DEFAULT 'America/Denver' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_lowercase" CHECK ("organizations"."slug" = lower("organizations"."slug"))
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"password_algo" text,
	"password_updated_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"role" "user_role" DEFAULT 'client' NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_failed_login_non_negative" CHECK ("users"."failed_login_count" >= 0),
	CONSTRAINT "users_session_epoch_non_negative" CHECK ("users"."session_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"provider" text DEFAULT 'umami' NOT NULL,
	"umami_website_id" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_readiness_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"check_key" text NOT NULL,
	"status" "readiness_status" DEFAULT 'unknown' NOT NULL,
	"detail" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"environment_id" uuid,
	"external_id" text,
	"commit_sha" text,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"url" text,
	"error" text,
	"is_rollback" boolean DEFAULT false NOT NULL,
	"rolled_back_from_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repository_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"site_id" uuid,
	"provider" text DEFAULT 'github' NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"repo_node_id" text,
	"installation_id" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"connection_mode" "connection_mode" DEFAULT 'managed' NOT NULL,
	"allowlisted" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" "environment_kind" NOT NULL,
	"url" text,
	"is_indexable" boolean DEFAULT false NOT NULL,
	"cf_worker_name" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"primary_domain" text,
	"status" "site_status" DEFAULT 'draft' NOT NULL,
	"theme_key" text,
	"theme_version" text,
	"launch_approved_at" timestamp with time zone,
	"launch_approved_by" uuid,
	"public_display_approved" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "sites_launch_requires_approver" CHECK (("sites"."launch_approved_at" IS NULL) = ("sites"."launch_approved_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "client_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"visibility" "visibility" DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"primary_contact_name" text,
	"primary_contact_email" text,
	"phone" text,
	"industry" text,
	"onboarding_status" text DEFAULT 'new' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "migration_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_project_id" uuid NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url_inventory" jsonb,
	"seo_baseline" jsonb,
	"secret_findings" jsonb,
	"redirect_map" jsonb,
	"risks" jsonb,
	"report_md" text
);
--> statement-breakpoint
CREATE TABLE "migration_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"site_id" uuid,
	"source_repo_owner" text,
	"source_repo_name" text,
	"authorization_text" text,
	"authorized_by_user_id" uuid,
	"authorized_at" timestamp with time zone,
	"scope" "migration_scope" DEFAULT 'read_only_audit' NOT NULL,
	"status" "migration_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_projects_authorization_complete" CHECK (("migration_projects"."authorized_at" IS NULL) = ("migration_projects"."authorized_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "migration_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "adjustment_kind" NOT NULL,
	"amount_cents_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"subscription_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"method" "payment_method" NOT NULL,
	"provider" text,
	"provider_reference" text,
	"idempotency_key" text,
	"covers_period_start" date,
	"covers_period_end" date,
	"received_on" date NOT NULL,
	"recorded_by" uuid,
	"status" "payment_status" DEFAULT 'recorded' NOT NULL,
	"note" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_non_negative" CHECK ("payments"."amount_cents" >= 0),
	CONSTRAINT "payments_period_order" CHECK ("payments"."covers_period_end" IS NULL OR "payments"."covers_period_start" IS NULL OR "payments"."covers_period_end" >= "payments"."covers_period_start")
);
--> statement-breakpoint
CREATE TABLE "service_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_monthly_cents" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_plans_price_non_negative" CHECK ("service_plans"."default_monthly_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"plan_id" uuid,
	"monthly_price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_day" integer DEFAULT 1 NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_price_non_negative" CHECK ("subscriptions"."monthly_price_cents" >= 0),
	CONSTRAINT "subscriptions_billing_day_range" CHECK ("subscriptions"."billing_day" BETWEEN 1 AND 28),
	CONSTRAINT "subscriptions_period_order" CHECK ("subscriptions"."ended_on" IS NULL OR "subscriptions"."ended_on" >= "subscriptions"."started_on")
);
--> statement-breakpoint
CREATE TABLE "audited_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_job_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status_code" integer,
	"title" text,
	"meta_description" text,
	"h1" text,
	"canonical" text,
	"content_hash" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"audit_job_id" uuid,
	"key" text NOT NULL,
	"value" text,
	"source_url" text,
	"source_type" "fact_source" DEFAULT 'crawl' NOT NULL,
	"verification" "fact_verification" DEFAULT 'unverified' NOT NULL,
	"confidence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_facts_confidence_range" CHECK ("business_facts"."confidence" IS NULL OR "business_facts"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "business_facts_crawl_not_self_verified" CHECK (NOT ("business_facts"."source_type" = 'crawl' AND "business_facts"."verification" = 'user_verified' AND "business_facts"."source_url" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "concept_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"prospect_id" uuid NOT NULL,
	"theme_key" text,
	"theme_variant" text,
	"theme_version" text,
	"status" "concept_status" DEFAULT 'draft' NOT NULL,
	"plan_md" text,
	"plan_approval_required" boolean DEFAULT true NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_jobs_approval_complete" CHECK (("concept_jobs"."approved_at" IS NULL) = ("concept_jobs"."approved_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "concept_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_job_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"node_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_repositories_private_only" CHECK ("concept_repositories"."visibility" = 'private')
);
--> statement-breakpoint
CREATE TABLE "preview_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"concept_job_id" uuid,
	"site_id" uuid,
	"url" text,
	"noindex_verified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_deployments_subject_required" CHECK (("preview_deployments"."concept_job_id" IS NOT NULL) OR ("preview_deployments"."site_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "prospect_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"role" text,
	"consent_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"organization_id" uuid,
	"site_id" uuid,
	"repo_strategy" "repo_strategy" DEFAULT 'fresh_repo' NOT NULL,
	"asset_rights_confirmed" boolean DEFAULT false NOT NULL,
	"converted_by" uuid,
	"converted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "prospect_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"viewed_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"business_name" text NOT NULL,
	"source_website_url" text,
	"industry" text,
	"status" "prospect_status" DEFAULT 'new' NOT NULL,
	"location" text,
	"service_area" text,
	"tone" text,
	"notes" text,
	"expires_on" date,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"viewport" "viewport" NOT NULL,
	"r2_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_audit_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"prospect_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"url_allowlist" jsonb,
	"max_pages" integer DEFAULT 25 NOT NULL,
	"max_depth" integer DEFAULT 3 NOT NULL,
	"robots_respected" boolean DEFAULT true NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_audit_jobs_max_pages_bounded" CHECK ("site_audit_jobs"."max_pages" BETWEEN 1 AND 200),
	CONSTRAINT "site_audit_jobs_max_depth_bounded" CHECK ("site_audit_jobs"."max_depth" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"request_id" uuid,
	"repository_connection_id" uuid,
	"issue_number" integer,
	"workflow_run_id" text,
	"pr_number" integer,
	"head_sha" text,
	"base_ref" text,
	"status" "agent_job_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"dispatched_at" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"decision" "approval_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_decision_complete" CHECK (("approvals"."decision" = 'pending') = ("approvals"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"created_by_user_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"category" "request_category" DEFAULT 'other' NOT NULL,
	"priority" "request_priority" DEFAULT 'normal' NOT NULL,
	"desired_timing" text,
	"status" "request_status" DEFAULT 'submitted' NOT NULL,
	"assigned_to" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_requests_title_not_blank" CHECK (length(btrim("change_requests"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"cap" integer DEFAULT 10 NOT NULL,
	CONSTRAINT "dispatch_quotas_count_non_negative" CHECK ("dispatch_quotas"."count" >= 0),
	CONSTRAINT "dispatch_quotas_cap_positive" CHECK ("dispatch_quotas"."cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"channel" "notification_channel" DEFAULT 'email' NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"dedupe_key" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"filename_original" text,
	"content_type_declared" text,
	"content_type_sniffed" text,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"checksum_sha256" text,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_attachments_size_bounded" CHECK ("request_attachments"."byte_size" > 0 AND "request_attachments"."byte_size" <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"kind" text NOT NULL,
	"body" text,
	"visibility" "visibility" DEFAULT 'internal' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text,
	"action" text,
	"repo_node_id" text,
	"signature_valid" boolean NOT NULL,
	"payload_digest" text,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_organization_id_organizations_id_fk" FOREIGN KEY ("target_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_connections" ADD CONSTRAINT "analytics_connections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_readiness_checks" ADD CONSTRAINT "automation_readiness_checks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_site_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."site_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_environments" ADD CONSTRAINT "site_environments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_launch_approved_by_users_id_fk" FOREIGN KEY ("launch_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_notes" ADD CONSTRAINT "client_notes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_notes" ADD CONSTRAINT "client_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_audits" ADD CONSTRAINT "migration_audits_migration_project_id_migration_projects_id_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."migration_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_projects" ADD CONSTRAINT "migration_projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_projects" ADD CONSTRAINT "migration_projects_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_projects" ADD CONSTRAINT "migration_projects_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_tasks" ADD CONSTRAINT "migration_tasks_migration_project_id_migration_projects_id_fk" FOREIGN KEY ("migration_project_id") REFERENCES "public"."migration_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_adjustments" ADD CONSTRAINT "payment_adjustments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_adjustments" ADD CONSTRAINT "payment_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audited_pages" ADD CONSTRAINT "audited_pages_audit_job_id_site_audit_jobs_id_fk" FOREIGN KEY ("audit_job_id") REFERENCES "public"."site_audit_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_facts" ADD CONSTRAINT "business_facts_audit_job_id_site_audit_jobs_id_fk" FOREIGN KEY ("audit_job_id") REFERENCES "public"."site_audit_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_jobs" ADD CONSTRAINT "concept_jobs_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_jobs" ADD CONSTRAINT "concept_jobs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_repositories" ADD CONSTRAINT "concept_repositories_concept_job_id_concept_jobs_id_fk" FOREIGN KEY ("concept_job_id") REFERENCES "public"."concept_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_concept_job_id_concept_jobs_id_fk" FOREIGN KEY ("concept_job_id") REFERENCES "public"."concept_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_contacts" ADD CONSTRAINT "prospect_contacts_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_converted_by_users_id_fk" FOREIGN KEY ("converted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_shares" ADD CONSTRAINT "prospect_shares_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_shares" ADD CONSTRAINT "prospect_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_audit_jobs" ADD CONSTRAINT "site_audit_jobs_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_audit_jobs" ADD CONSTRAINT "site_audit_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_request_id_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."change_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_repository_connection_id_repository_connections_id_fk" FOREIGN KEY ("repository_connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_time_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_time_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_tokens_hash_key" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_sessions_public_id_key" ON "impersonation_sessions" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "impersonation_sessions_admin_idx" ON "impersonation_sessions" USING btree ("admin_user_id","started_at");--> statement-breakpoint
CREATE INDEX "impersonation_sessions_open_idx" ON "impersonation_sessions" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "login_attempts_email_time_idx" ON "login_attempts" USING btree ("email_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_time_idx" ON "login_attempts" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_memberships_org_user_key" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_user_idx" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_public_id_key" ON "organizations" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_kind_idx" ON "organizations" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_hash_key" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_public_id_key" ON "users" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "users" USING btree ("role","status");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_connections_site_key" ON "analytics_connections" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "analytics_connections_website_idx" ON "analytics_connections" USING btree ("umami_website_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_readiness_site_check_key" ON "automation_readiness_checks" USING btree ("site_id","check_key");--> statement-breakpoint
CREATE INDEX "automation_readiness_status_idx" ON "automation_readiness_checks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_public_id_key" ON "deployments" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "deployments_site_time_idx" ON "deployments" USING btree ("site_id","started_at");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connections_public_id_key" ON "repository_connections" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connections_owner_name_key" ON "repository_connections" USING btree ("owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_connections_node_id_key" ON "repository_connections" USING btree ("repo_node_id");--> statement-breakpoint
CREATE INDEX "repository_connections_site_idx" ON "repository_connections" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_environments_site_kind_key" ON "site_environments" USING btree ("site_id","kind");--> statement-breakpoint
CREATE INDEX "site_environments_site_idx" ON "site_environments" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_public_id_key" ON "sites" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "sites_org_idx" ON "sites" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "sites_status_idx" ON "sites" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "client_notes_public_id_key" ON "client_notes" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "client_notes_client_visibility_idx" ON "client_notes" USING btree ("client_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_public_id_key" ON "clients" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_organization_key" ON "clients" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "clients_industry_idx" ON "clients" USING btree ("industry");--> statement-breakpoint
CREATE INDEX "migration_audits_project_idx" ON "migration_audits" USING btree ("migration_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_projects_public_id_key" ON "migration_projects" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "migration_projects_client_idx" ON "migration_projects" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_tasks_project_key" ON "migration_tasks" USING btree ("migration_project_id","key");--> statement-breakpoint
CREATE INDEX "payment_adjustments_payment_idx" ON "payment_adjustments" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_public_id_key" ON "payments" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_client_time_idx" ON "payments" USING btree ("client_id","received_on");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "service_plans_key_key" ON "service_plans" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_public_id_key" ON "subscriptions" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "subscriptions_client_idx" ON "subscriptions" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "audited_pages_job_url_key" ON "audited_pages" USING btree ("audit_job_id","url");--> statement-breakpoint
CREATE INDEX "audited_pages_job_idx" ON "audited_pages" USING btree ("audit_job_id");--> statement-breakpoint
CREATE INDEX "business_facts_prospect_key_idx" ON "business_facts" USING btree ("prospect_id","key");--> statement-breakpoint
CREATE INDEX "business_facts_verification_idx" ON "business_facts" USING btree ("verification");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_jobs_public_id_key" ON "concept_jobs" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "concept_jobs_prospect_idx" ON "concept_jobs" USING btree ("prospect_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_repositories_owner_name_key" ON "concept_repositories" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX "concept_repositories_job_idx" ON "concept_repositories" USING btree ("concept_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "preview_deployments_public_id_key" ON "preview_deployments" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "preview_deployments_concept_idx" ON "preview_deployments" USING btree ("concept_job_id");--> statement-breakpoint
CREATE INDEX "preview_deployments_site_idx" ON "preview_deployments" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "prospect_contacts_prospect_idx" ON "prospect_contacts" USING btree ("prospect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_conversions_prospect_key" ON "prospect_conversions" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "prospect_conversions_client_idx" ON "prospect_conversions" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_shares_token_key" ON "prospect_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "prospect_shares_prospect_idx" ON "prospect_shares" USING btree ("prospect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_public_id_key" ON "prospects" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "prospects_status_idx" ON "prospects" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "prospects_industry_idx" ON "prospects" USING btree ("industry");--> statement-breakpoint
CREATE INDEX "screenshots_subject_idx" ON "screenshots" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "screenshots_r2_key_key" ON "screenshots" USING btree ("r2_key");--> statement-breakpoint
CREATE UNIQUE INDEX "site_audit_jobs_public_id_key" ON "site_audit_jobs" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "site_audit_jobs_prospect_idx" ON "site_audit_jobs" USING btree ("prospect_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_public_id_key" ON "agent_jobs" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "agent_jobs_request_idx" ON "agent_jobs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "agent_jobs_status_idx" ON "agent_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_jobs_timeout_idx" ON "agent_jobs" USING btree ("timeout_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_public_id_key" ON "approvals" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "approvals_subject_idx" ON "approvals" USING btree ("subject_type","subject_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_public_id_key" ON "change_requests" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "change_requests_org_time_idx" ON "change_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "change_requests_org_status_idx" ON "change_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "change_requests_site_idx" ON "change_requests" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_quotas_day_scope_key" ON "dispatch_quotas" USING btree ("day","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_public_id_key" ON "notifications" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "request_attachments_public_id_key" ON "request_attachments" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_attachments_r2_key_key" ON "request_attachments" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "request_attachments_request_idx" ON "request_attachments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_events_request_time_idx" ON "request_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "request_events_visibility_idx" ON "request_events" USING btree ("request_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_delivery_key" ON "webhook_deliveries" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_repo_idx" ON "webhook_deliveries" USING btree ("repo_node_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event","action");