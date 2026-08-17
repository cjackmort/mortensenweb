import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Enumerations shared across the schema.
 *
 * These are database-level enums rather than free text so an invalid state
 * cannot be written by any code path, including a future migration script or a
 * manual query.
 */

// ---- Identity -------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["admin", "client"]);

export const userStatusEnum = pgEnum("user_status", [
  "invited",
  "active",
  "disabled",
]);

export const organizationKindEnum = pgEnum("organization_kind", [
  "agency",
  "client",
]);

export const membershipRoleEnum = pgEnum("membership_role", ["owner", "member"]);

// ---- Sites ----------------------------------------------------------------

export const siteStatusEnum = pgEnum("site_status", [
  "draft",
  "preview",
  "live",
  "archived",
]);

export const environmentKindEnum = pgEnum("environment_kind", [
  "preview",
  "production",
]);

/**
 * How the platform relates to a repository.
 *  - managed:            we created it from a theme
 *  - connected_existing: the client's own repo, connected in place
 *  - transferred:        an existing repo moved under our ownership
 */
export const connectionModeEnum = pgEnum("connection_mode", [
  "managed",
  "connected_existing",
  "transferred",
]);

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "queued",
  "building",
  "succeeded",
  "failed",
  "cancelled",
]);

export const readinessStatusEnum = pgEnum("readiness_status", [
  "pass",
  "warn",
  "fail",
  "unknown",
]);

// ---- Commercial -----------------------------------------------------------

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "paused",
  "cancelled",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "venmo",
  "check",
  "card",
  "bank_transfer",
  "stripe",
  "square",
  "other",
]);

export const paymentStatusEnum = pgEnum("payment_status", ["recorded", "void"]);

/**
 * Whether the agency is actively working on a client's site.
 *
 * Non-payment pauses *management*, never hosting. Taking a small business's
 * website offline over a late invoice does them disproportionate harm and
 * reflects badly on the agency; withdrawing labour is the proportionate
 * response. `unmanaged` therefore means the site stays up and reachable while
 * change requests and automation stop.
 */
export const managementStateEnum = pgEnum("management_state", [
  "managed",
  "at_risk",
  "unmanaged",
]);

/** Rungs of the reminder ladder. Recorded so a rung cannot be sent twice. */
export const dunningStageEnum = pgEnum("dunning_stage", [
  "none",
  "first_reminder",
  "second_reminder",
  "final_notice",
  "management_paused",
]);

/**
 * Lifecycle of a request for payment.
 *
 * `awaiting_confirmation` is the state that off-platform rails make necessary:
 * the client says they have paid, and nobody has yet verified that money
 * arrived. It is deliberately distinct from `paid` — the portal must never tell
 * a client they are paid up on their say-so alone.
 */
export const paymentRequestStatusEnum = pgEnum("payment_request_status", [
  "draft",
  "open",
  "awaiting_confirmation",
  "paid",
  "overdue",
  "cancelled",
  "written_off",
]);

/**
 * Payments are never deleted. Corrections are appended as adjustments so the
 * ledger stays auditable.
 */
export const adjustmentKindEnum = pgEnum("adjustment_kind", [
  "correction",
  "refund",
  "void",
  "writeoff",
]);

/**
 * The single most security-relevant enum in the schema. Any record carrying
 * `internal` must never reach a client-facing query.
 */
export const visibilityEnum = pgEnum("visibility", [
  "internal",
  "client_visible",
]);

// ---- Migration ------------------------------------------------------------

/**
 * Authorised scope for a client migration. Enforced in code: at
 * `read_only_audit` there is no reachable write path to the source repository.
 */
export const migrationScopeEnum = pgEnum("migration_scope", [
  "read_only_audit",
  "branch_changes",
  "launch",
]);

export const migrationStatusEnum = pgEnum("migration_status", [
  "draft",
  "awaiting_authorization",
  "authorized",
  "auditing",
  "audited",
  "in_progress",
  "awaiting_launch_approval",
  "launched",
  "rolled_back",
  "abandoned",
]);

// ---- Prospects ------------------------------------------------------------

export const prospectStatusEnum = pgEnum("prospect_status", [
  "new",
  "auditing",
  "audited",
  "concept_pending",
  "concept_ready",
  "shared",
  "converted",
  "declined",
  "expired",
]);

export const factSourceEnum = pgEnum("fact_source", [
  "crawl",
  "user_supplied",
  "inferred",
]);

/**
 * Only `user_verified` and `user_supplied` facts may render into a generated
 * site. `sensitive` covers claims that must never be auto-published: licence
 * numbers, certifications, warranty terms, pricing, award claims.
 */
export const factVerificationEnum = pgEnum("fact_verification", [
  "unverified",
  "user_verified",
  "conflicting",
  "sensitive",
]);

export const conceptStatusEnum = pgEnum("concept_status", [
  "draft",
  "plan_pending_approval",
  "approved",
  "scaffolding",
  "building",
  "deployed",
  "failed",
  "expired",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const repoStrategyEnum = pgEnum("repo_strategy", [
  "rename_transfer",
  "fresh_repo",
]);

export const viewportEnum = pgEnum("viewport", ["mobile", "tablet", "desktop"]);

// ---- Change operations ----------------------------------------------------

export const requestStatusEnum = pgEnum("request_status", [
  "submitted",
  "triaged",
  "approved",
  "rejected",
  "dispatched",
  "in_progress",
  "pr_open",
  "changes_requested",
  "merged",
  "deployed",
  "verified",
  "closed",
  "failed",
  "rolled_back",
]);

export const requestPriorityEnum = pgEnum("request_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const requestCategoryEnum = pgEnum("request_category", [
  "content",
  "design",
  "bug",
  "seo",
  "feature",
  "other",
]);

export const actorTypeEnum = pgEnum("actor_type", [
  "client",
  "admin",
  "system",
  "agent",
]);

export const scanStatusEnum = pgEnum("scan_status", [
  "pending",
  "clean",
  "flagged",
  "skipped",
]);

export const approvalKindEnum = pgEnum("approval_kind", [
  "concept_plan",
  "pr_merge",
  "preview",
  "production_launch",
  "migration_scope",
  "public_display",
]);

export const approvalDecisionEnum = pgEnum("approval_decision", [
  "pending",
  "approved",
  "rejected",
]);

export const agentJobStatusEnum = pgEnum("agent_job_status", [
  "queued",
  "dispatched",
  "running",
  "pr_open",
  "merged",
  "failed",
  "timed_out",
  "cancelled",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "in_app",
]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "suppressed",
]);

// ---- Commercial entitlements ----------------------------------------------

/**
 * How a change request is paid for.
 *
 * Recorded on the request at submission time rather than computed later,
 * because the answer depends on the allowance state *at that moment* and a
 * later recomputation would give a different — and unbillable — answer.
 *
 * `courtesy` exists because it will be needed: a change we got wrong, or a
 * goodwill gesture, must be distinguishable in the ledger from one the client
 * paid for. Without it the only way to not charge someone is to quietly skip
 * the accounting, which is how revenue figures stop being true.
 */
export const billingTreatmentEnum = pgEnum("billing_treatment", [
  "included",
  "overage",
  "courtesy",
]);

/**
 * What a payment request is *for*.
 *
 * Recorded rather than inferred. Without it, "was this an extra change or the
 * monthly fee?" would have to be guessed from whether a subscription id happens
 * to be attached — and getting that wrong grants a client a change they did not
 * buy, or fails to grant one they did.
 */
export const paymentPurposeEnum = pgEnum("payment_purpose", [
  "subscription",
  "extra_change",
  "other",
]);

// ---- Briefs ---------------------------------------------------------------

/**
 * Where a brief came from. The distinction matters for what the agent is told:
 * a `discovery` brief describes a site being built for the first time, a
 * `revision` brief describes changing one that exists.
 */
export const briefKindEnum = pgEnum("brief_kind", ["discovery", "revision"]);

export const briefStatusEnum = pgEnum("brief_status", [
  "draft",
  "submitted",
  "dispatched",
  "applied",
  "cancelled",
]);

// ---- Previews -------------------------------------------------------------

/**
 * What a preview deployment is a preview *of*.
 *
 * A prospect concept and a pull request preview have different lifetimes,
 * different audiences, and different deletion rules, and telling them apart in
 * a query is worth an explicit column.
 */
export const previewKindEnum = pgEnum("preview_kind", [
  "concept",
  "pull_request",
  "production",
]);

/**
 * The client's verdict on a preview.
 *
 * `pending` is not a decision — it is the absence of one, and the Apply path
 * refuses to merge anything that is not explicitly `approved`.
 */
export const previewDecisionEnum = pgEnum("preview_decision", [
  "pending",
  "approved",
  "changes_requested",
]);
