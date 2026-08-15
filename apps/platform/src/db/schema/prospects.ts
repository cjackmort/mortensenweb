import { sql } from "drizzle-orm";
import {
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
import { sites } from "./sites";
import { clients } from "./clients";
import {
  conceptStatusEnum,
  factSourceEnum,
  factVerificationEnum,
  jobStatusEnum,
  prospectStatusEnum,
  repoStrategyEnum,
  viewportEnum,
} from "./enums";

/**
 * Potential clients: admin-only sales and concept generation.
 *
 * Nothing here is ever reachable by a client user, enforced by route group and
 * by the absence of any client-facing repository that touches these tables.
 */

export const prospects = pgTable(
  "prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    businessName: text("business_name").notNull(),
    sourceWebsiteUrl: text("source_website_url"),
    industry: text("industry"),
    status: prospectStatusEnum("status").notNull().default("new"),
    location: text("location"),
    serviceArea: text("service_area"),
    tone: text("tone"),
    notes: text("notes"),
    expiresOn: date("expires_on"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("prospects_public_id_key").on(t.publicId),
    index("prospects_status_idx").on(t.status, t.updatedAt),
    index("prospects_industry_idx").on(t.industry),
  ],
);

export const prospectContacts = pgTable(
  "prospect_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    role: text("role"),
    /** Why we hold this contact. There is no automated outreach path. */
    consentNote: text("consent_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("prospect_contacts_prospect_idx").on(t.prospectId)],
);

export const siteAuditJobs = pgTable(
  "site_audit_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("queued"),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    urlAllowlist: jsonb("url_allowlist"),
    maxPages: integer("max_pages").notNull().default(25),
    maxDepth: integer("max_depth").notNull().default(3),
    robotsRespected: boolean("robots_respected").notNull().default(true),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("site_audit_jobs_public_id_key").on(t.publicId),
    index("site_audit_jobs_prospect_idx").on(t.prospectId, t.createdAt),
    check("site_audit_jobs_max_pages_bounded", sql`${t.maxPages} BETWEEN 1 AND 200`),
    check("site_audit_jobs_max_depth_bounded", sql`${t.maxDepth} BETWEEN 1 AND 10`),
  ],
);

export const auditedPages = pgTable(
  "audited_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditJobId: uuid("audit_job_id")
      .notNull()
      .references(() => siteAuditJobs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    statusCode: integer("status_code"),
    title: text("title"),
    metaDescription: text("meta_description"),
    h1: text("h1"),
    canonical: text("canonical"),
    contentHash: text("content_hash"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("audited_pages_job_url_key").on(t.auditJobId, t.url),
    index("audited_pages_job_idx").on(t.auditJobId),
  ],
);

/**
 * The anti-fabrication control.
 *
 * Only `user_verified` and `user_supplied` facts may render into a generated
 * site. Everything else renders as an explicit placeholder, and `sensitive`
 * facts (licence numbers, pricing, guarantees, awards) are never auto-published.
 */
export const businessFacts = pgTable(
  "business_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    auditJobId: uuid("audit_job_id").references(() => siteAuditJobs.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    value: text("value"),
    sourceUrl: text("source_url"),
    sourceType: factSourceEnum("source_type").notNull().default("crawl"),
    verification: factVerificationEnum("verification")
      .notNull()
      .default("unverified"),
    confidence: integer("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("business_facts_prospect_key_idx").on(t.prospectId, t.key),
    index("business_facts_verification_idx").on(t.verification),
    check(
      "business_facts_confidence_range",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 100`,
    ),
    // A crawled fact can never be born verified; verification is a human act.
    check(
      "business_facts_crawl_not_self_verified",
      sql`NOT (${t.sourceType} = 'crawl' AND ${t.verification} = 'user_verified' AND ${t.sourceUrl} IS NULL)`,
    ),
  ],
);

export const conceptJobs = pgTable(
  "concept_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    themeKey: text("theme_key"),
    themeVariant: text("theme_variant"),
    themeVersion: text("theme_version"),
    status: conceptStatusEnum("status").notNull().default("draft"),
    planMd: text("plan_md"),
    planApprovalRequired: boolean("plan_approval_required")
      .notNull()
      .default(true),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("concept_jobs_public_id_key").on(t.publicId),
    index("concept_jobs_prospect_idx").on(t.prospectId, t.createdAt),
    check(
      "concept_jobs_approval_complete",
      sql`(${t.approvedAt} IS NULL) = (${t.approvedBy} IS NULL)`,
    ),
  ],
);

export const conceptRepositories = pgTable(
  "concept_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conceptJobId: uuid("concept_job_id")
      .notNull()
      .references(() => conceptJobs.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    nodeId: text("node_id"),
    visibility: text("visibility").notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("concept_repositories_owner_name_key").on(t.owner, t.name),
    index("concept_repositories_job_idx").on(t.conceptJobId),
    // A prospect concept repository must never be public.
    check(
      "concept_repositories_private_only",
      sql`${t.visibility} = 'private'`,
    ),
  ],
);

export const previewDeployments = pgTable(
  "preview_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    conceptJobId: uuid("concept_job_id").references(() => conceptJobs.id, {
      onDelete: "cascade",
    }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
    url: text("url"),
    /** Set only after the deployed preview is actually checked, not assumed. */
    noindexVerified: boolean("noindex_verified").notNull().default(false),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("preview_deployments_public_id_key").on(t.publicId),
    index("preview_deployments_concept_idx").on(t.conceptJobId),
    index("preview_deployments_site_idx").on(t.siteId),
    check(
      "preview_deployments_subject_required",
      sql`(${t.conceptJobId} IS NOT NULL) OR (${t.siteId} IS NOT NULL)`,
    ),
  ],
);

export const screenshots = pgTable(
  "screenshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    viewport: viewportEnum("viewport").notNull(),
    r2Key: text("r2_key").notNull(),
    width: integer("width"),
    height: integer("height"),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("screenshots_subject_idx").on(t.subjectType, t.subjectId),
    uniqueIndex("screenshots_r2_key_key").on(t.r2Key),
  ],
);

/**
 * Revocable, expiring share links. Only the token hash is stored.
 */
export const prospectShares = pgTable(
  "prospect_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    viewedCount: integer("viewed_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("prospect_shares_token_key").on(t.tokenHash),
    index("prospect_shares_prospect_idx").on(t.prospectId),
  ],
);

export const prospectConversions = pgTable(
  "prospect_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    repoStrategy: repoStrategyEnum("repo_strategy")
      .notNull()
      .default("fresh_repo"),
    /** Explicit confirmation that content and asset rights were checked. */
    assetRightsConfirmed: boolean("asset_rights_confirmed")
      .notNull()
      .default(false),
    convertedBy: uuid("converted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    convertedAt: timestamp("converted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("prospect_conversions_prospect_key").on(t.prospectId),
    index("prospect_conversions_client_idx").on(t.clientId),
  ],
);
