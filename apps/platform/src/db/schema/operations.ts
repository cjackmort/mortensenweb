import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { repositoryConnections, sites } from "./sites";
import { changeAllowances, paymentRequests } from "./clients";
import {
  actorTypeEnum,
  agentJobStatusEnum,
  approvalDecisionEnum,
  approvalKindEnum,
  billingTreatmentEnum,
  briefKindEnum,
  briefStatusEnum,
  notificationChannelEnum,
  notificationStatusEnum,
  previewDecisionEnum,
  requestCategoryEnum,
  requestPriorityEnum,
  requestStatusEnum,
  scanStatusEnum,
  visibilityEnum,
} from "./enums";

/**
 * Change operations: the request lifecycle and the automation pipeline.
 */

export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    /** Tenancy key. Every client-facing query filters on this column. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    category: requestCategoryEnum("category").notNull().default("other"),
    priority: requestPriorityEnum("priority").notNull().default("normal"),
    desiredTiming: text("desired_timing"),
    status: requestStatusEnum("status").notNull().default("submitted"),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * How this change is paid for, decided at submission and never recomputed.
     *
     * Recomputing it later would give a different answer, because the answer
     * depends on how much of the allowance was left *at that moment*. A request
     * submitted as the third of three included changes stays `included` even
     * after the client submits a fourth.
     */
    billing: billingTreatmentEnum("billing").notNull().default("included"),
    /** The period this request was counted against. Null for courtesy work. */
    allowanceId: uuid("allowance_id").references(() => changeAllowances.id, {
      onDelete: "set null",
    }),
    /** Set when the change was billed as an overage and an invoice was raised. */
    paymentRequestId: uuid("payment_request_id").references(
      () => paymentRequests.id,
      { onDelete: "set null" },
    ),

    isDemo: boolean("is_demo").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("change_requests_public_id_key").on(t.publicId),
    index("change_requests_org_time_idx").on(t.organizationId, t.createdAt),
    index("change_requests_org_status_idx").on(t.organizationId, t.status),
    index("change_requests_site_idx").on(t.siteId),
    check("change_requests_title_not_blank", sql`length(btrim(${t.title})) > 0`),
  ],
);

export const requestAttachments = pgTable(
  "request_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => changeRequests.id, { onDelete: "cascade" }),
    /** Random opaque key. User filenames never appear in the object key. */
    r2Key: text("r2_key").notNull(),
    filenameOriginal: text("filename_original"),
    contentTypeDeclared: text("content_type_declared"),
    /** Result of magic-byte inspection, not the client's claim. */
    contentTypeSniffed: text("content_type_sniffed"),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    checksumSha256: text("checksum_sha256"),
    scanStatus: scanStatusEnum("scan_status").notNull().default("pending"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("request_attachments_public_id_key").on(t.publicId),
    uniqueIndex("request_attachments_r2_key_key").on(t.r2Key),
    index("request_attachments_request_idx").on(t.requestId),
    // 10 MB cap, enforced by the database as well as the application.
    check(
      "request_attachments_size_bounded",
      sql`${t.byteSize} > 0 AND ${t.byteSize} <= 10485760`,
    ),
  ],
);

/**
 * One timeline table, two audiences. The client-facing repository hard-filters
 * `visibility = 'client_visible'`; internal agent logs never leak into it.
 */
export const requestEvents = pgTable(
  "request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => changeRequests.id, { onDelete: "cascade" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    body: text("body"),
    visibility: visibilityEnum("visibility").notNull().default("internal"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("request_events_request_time_idx").on(t.requestId, t.createdAt),
    index("request_events_visibility_idx").on(t.requestId, t.visibility),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    kind: approvalKindEnum("kind").notNull(),
    decision: approvalDecisionEnum("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("approvals_public_id_key").on(t.publicId),
    index("approvals_subject_idx").on(t.subjectType, t.subjectId, t.kind),
    check(
      "approvals_decision_complete",
      sql`(${t.decision} = 'pending') = (${t.decidedAt} IS NULL)`,
    ),
  ],
);

/**
 * One automation run: portal issue -> Claude workflow -> pull request -> merge.
 * `headSha` is captured at approval time; a change invalidates the merge.
 */
export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    requestId: uuid("request_id").references(() => changeRequests.id, {
      onDelete: "set null",
    }),
    repositoryConnectionId: uuid("repository_connection_id").references(
      () => repositoryConnections.id,
      { onDelete: "set null" },
    ),
    /**
     * Set when the job came from an operator brief rather than a client
     * request. Declared as a forward reference because `site_briefs` is defined
     * below; Drizzle resolves the callback lazily, after the module evaluates.
     */
    briefId: uuid("brief_id").references((): AnyPgColumn => siteBriefs.id, {
      onDelete: "set null",
    }),
    issueNumber: integer("issue_number"),
    workflowRunId: text("workflow_run_id"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    headSha: text("head_sha"),
    baseRef: text("base_ref"),
    status: agentJobStatusEnum("status").notNull().default("queued"),
    error: text("error"),

    /**
     * The deploy preview of this pull request — what the client actually looks
     * at before approving.
     *
     * `previewVerifiedAt` is the gate on showing it. A URL is *derived* from the
     * pull request number and the site name, so it exists as a string long
     * before the build that would make it resolve. Presenting an unverified URL
     * to a client means sending them to a 404 and asking them to approve it,
     * which is worse than showing nothing. Same discipline as
     * `preview_deployments.noindex_verified`: constructed, then checked, then
     * trusted.
     */
    previewUrl: text("preview_url"),
    previewVerifiedAt: timestamp("preview_verified_at", { withTimezone: true }),

    /**
     * The client's verdict. `pending` is the absence of a decision, and the
     * merge path refuses anything that is not explicitly `approved`.
     */
    clientDecision: previewDecisionEnum("client_decision")
      .notNull()
      .default("pending"),
    clientDecisionAt: timestamp("client_decision_at", { withTimezone: true }),
    clientDecisionByUserId: uuid("client_decision_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),

    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergeCommitSha: text("merge_commit_sha"),

    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_jobs_public_id_key").on(t.publicId),
    index("agent_jobs_request_idx").on(t.requestId),
    index("agent_jobs_status_idx").on(t.status),
    index("agent_jobs_timeout_idx").on(t.timeoutAt),
    index("agent_jobs_brief_idx").on(t.briefId),
    // Correlating an incoming webhook needs (repo, pr) -> job.
    index("agent_jobs_repo_pr_idx").on(t.repositoryConnectionId, t.prNumber),
    // A decision always has a time attached; "approved by nobody, at no point"
    // must not be representable, because that row would authorise a merge.
    check(
      "agent_jobs_decision_complete",
      sql`(${t.clientDecision} = 'pending') = (${t.clientDecisionAt} IS NULL)`,
    ),
  ],
);

/**
 * An operator brief — what a client said they wanted, written down after a call.
 *
 * Kept as its own record rather than a client note because this text becomes an
 * agent's instructions. That means it needs a status, a dispatch record, and an
 * audit trail, none of which a free-form note has.
 *
 * Note what it is *not*: a trusted channel. The text is dictated by a client
 * over a call and typed by the operator, so it goes through exactly the same
 * injection-contained issue renderer as client-submitted text. The operator
 * typing it does not make a third party's words safe.
 */
export const siteBriefs = pgTable(
  "site_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    kind: briefKindEnum("kind").notNull().default("revision"),
    status: briefStatusEnum("status").notNull().default("draft"),

    /** Structured prompts, kept separate so the agent gets labelled sections. */
    colourDirection: text("colour_direction"),
    features: text("features"),
    contentNotes: text("content_notes"),
    /** Everything that did not fit the boxes above. */
    body: text("body"),

    authoredByUserId: uuid("authored_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("site_briefs_public_id_key").on(t.publicId),
    index("site_briefs_org_idx").on(t.organizationId, t.createdAt),
    index("site_briefs_status_idx").on(t.status),
    // A brief with nothing in any field would dispatch an empty instruction.
    check(
      "site_briefs_not_empty",
      sql`length(btrim(coalesce(${t.colourDirection}, '') || coalesce(${t.features}, '') || coalesce(${t.contentNotes}, '') || coalesce(${t.body}, ''))) > 0`,
    ),
    check(
      "site_briefs_submitted_complete",
      sql`${t.status} = 'draft' OR ${t.submittedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Webhook idempotency.
 *
 * The unique index on `deliveryId` IS the idempotency mechanism: a duplicate
 * delivery fails to insert and is acknowledged without reprocessing.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("github"),
    deliveryId: text("delivery_id").notNull(),
    event: text("event"),
    action: text("action"),
    repoNodeId: text("repo_node_id"),
    signatureValid: boolean("signature_valid").notNull(),
    payloadDigest: text("payload_digest"),
    status: text("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_delivery_key").on(t.provider, t.deliveryId),
    index("webhook_deliveries_repo_idx").on(t.repoNodeId, t.receivedAt),
    index("webhook_deliveries_event_idx").on(t.event, t.action),
  ],
);

/** Daily dispatch cap, default 10, configurable globally and per repository. */
export const dispatchQuotas = pgTable(
  "dispatch_quotas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day").notNull(),
    scope: text("scope").notNull().default("global"),
    count: integer("count").notNull().default(0),
    cap: integer("cap").notNull().default(10),
  },
  (t) => [
    uniqueIndex("dispatch_quotas_day_scope_key").on(t.day, t.scope),
    check("dispatch_quotas_count_non_negative", sql`${t.count} >= 0`),
    check("dispatch_quotas_cap_positive", sql`${t.cap} > 0`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    channel: notificationChannelEnum("channel").notNull().default("email"),
    status: notificationStatusEnum("status").notNull().default("pending"),
    /** Prevents duplicate sends on webhook retries. */
    dedupeKey: text("dedupe_key"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_public_id_key").on(t.publicId),
    uniqueIndex("notifications_dedupe_key").on(t.dedupeKey),
    index("notifications_user_idx").on(t.userId, t.createdAt),
    index("notifications_status_idx").on(t.status),
  ],
);
