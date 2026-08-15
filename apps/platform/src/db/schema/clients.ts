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
import {
  adjustmentKindEnum,
  migrationScopeEnum,
  migrationStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  subscriptionStatusEnum,
  visibilityEnum,
} from "./enums";

/**
 * Commercial records.
 *
 * `organizations` is the tenancy boundary; `clients` is the commercial record.
 * Keeping them separate means a billing change can never affect access control.
 */

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    primaryContactName: text("primary_contact_name"),
    primaryContactEmail: text("primary_contact_email"),
    phone: text("phone"),
    industry: text("industry"),
    onboardingStatus: text("onboarding_status").notNull().default("new"),
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
    uniqueIndex("clients_public_id_key").on(t.publicId),
    uniqueIndex("clients_organization_key").on(t.organizationId),
    index("clients_industry_idx").on(t.industry),
  ],
);

export const servicePlans = pgTable(
  "service_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Integer cents. No floating point money anywhere in this schema. */
    defaultMonthlyCents: integer("default_monthly_cents").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("service_plans_key_key").on(t.key),
    check(
      "service_plans_price_non_negative",
      sql`${t.defaultMonthlyCents} >= 0`,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => servicePlans.id, {
      onDelete: "restrict",
    }),
    monthlyPriceCents: integer("monthly_price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    billingDay: integer("billing_day").notNull().default(1),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    startedOn: date("started_on").notNull(),
    endedOn: date("ended_on"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("subscriptions_public_id_key").on(t.publicId),
    index("subscriptions_client_idx").on(t.clientId, t.status),
    check("subscriptions_price_non_negative", sql`${t.monthlyPriceCents} >= 0`),
    check(
      "subscriptions_billing_day_range",
      sql`${t.billingDay} BETWEEN 1 AND 28`,
    ),
    check(
      "subscriptions_period_order",
      sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`,
    ),
  ],
);

/**
 * Payments are append-only. Nothing in the application deletes a row here;
 * corrections are recorded as adjustments so the ledger stays auditable.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    method: paymentMethodEnum("method").notNull(),
    /** Reserved for Stripe. Present now so adding it needs no migration. */
    provider: text("provider"),
    providerReference: text("provider_reference"),
    idempotencyKey: text("idempotency_key"),
    coversPeriodStart: date("covers_period_start"),
    coversPeriodEnd: date("covers_period_end"),
    receivedOn: date("received_on").notNull(),
    recordedBy: uuid("recorded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    status: paymentStatusEnum("status").notNull().default("recorded"),
    note: text("note"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_public_id_key").on(t.publicId),
    uniqueIndex("payments_idempotency_key").on(t.idempotencyKey),
    index("payments_client_time_idx").on(t.clientId, t.receivedOn),
    index("payments_status_idx").on(t.status),
    check("payments_amount_non_negative", sql`${t.amountCents} >= 0`),
    check(
      "payments_period_order",
      sql`${t.coversPeriodEnd} IS NULL OR ${t.coversPeriodStart} IS NULL OR ${t.coversPeriodEnd} >= ${t.coversPeriodStart}`,
    ),
  ],
);

export const paymentAdjustments = pgTable(
  "payment_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    kind: adjustmentKindEnum("kind").notNull(),
    /** Signed: a refund is negative, a correction may be either direction. */
    amountCentsDelta: integer("amount_cents_delta").notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("payment_adjustments_payment_idx").on(t.paymentId)],
);

/**
 * Internal notes and client-visible communication share a table but are
 * separated by `visibility`, which the client-facing repository hard-filters.
 */
export const clientNotes = pgTable(
  "client_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    /** Defaults to internal: a note is private unless deliberately shared. */
    visibility: visibilityEnum("visibility").notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("client_notes_public_id_key").on(t.publicId),
    index("client_notes_client_visibility_idx").on(t.clientId, t.visibility),
  ],
);

/**
 * Migration projects.
 *
 * `authorizationText` stores the operator's verbatim written authorization.
 * `scope` is enforced in code: at `read_only_audit` no write path to the
 * source repository is reachable.
 */
export const migrationProjects = pgTable(
  "migration_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    sourceRepoOwner: text("source_repo_owner"),
    sourceRepoName: text("source_repo_name"),
    authorizationText: text("authorization_text"),
    authorizedByUserId: uuid("authorized_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    scope: migrationScopeEnum("scope").notNull().default("read_only_audit"),
    status: migrationStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("migration_projects_public_id_key").on(t.publicId),
    index("migration_projects_client_idx").on(t.clientId, t.status),
    // A repository may only be named once authorization has been recorded.
    check(
      "migration_projects_authorization_complete",
      sql`(${t.authorizedAt} IS NULL) = (${t.authorizedByUserId} IS NULL)`,
    ),
  ],
);

export const migrationTasks = pgTable(
  "migration_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationProjectId: uuid("migration_project_id")
      .notNull()
      .references(() => migrationProjects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("pending"),
    blocking: boolean("blocking").notNull().default(false),
    result: jsonb("result"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("migration_tasks_project_key").on(t.migrationProjectId, t.key),
  ],
);

export const migrationAudits = pgTable(
  "migration_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationProjectId: uuid("migration_project_id")
      .notNull()
      .references(() => migrationProjects.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    urlInventory: jsonb("url_inventory"),
    seoBaseline: jsonb("seo_baseline"),
    /** Counts, rule names, and paths only. Never the matched values. */
    secretFindings: jsonb("secret_findings"),
    redirectMap: jsonb("redirect_map"),
    risks: jsonb("risks"),
    reportMd: text("report_md"),
  },
  (t) => [index("migration_audits_project_idx").on(t.migrationProjectId)],
);
