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
  dunningStageEnum,
  managementStateEnum,
  migrationScopeEnum,
  migrationStatusEnum,
  paymentMethodEnum,
  paymentPurposeEnum,
  paymentRequestStatusEnum,
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

    /**
     * Whether we are actively working on this client's site. Non-payment
     * moves this to `unmanaged`; it never takes the site down.
     */
    managementState: managementStateEnum("management_state")
      .notNull()
      .default("managed"),

    /**
     * Entitlement gates, set when the first payment is confirmed.
     *
     * These are columns rather than a derived `EXISTS (SELECT … FROM payments)`
     * on purpose. Derived access control cannot be audited, cannot be granted
     * by hand for a client who paid in cash before the portal existed, and
     * cannot be withdrawn without deleting ledger rows — which the ledger
     * forbids. A timestamp with an `audit_log` entry beside it answers "who
     * unlocked this, and when", which a subquery never can.
     *
     * Null means locked. The portal shows a client an explicit "unlock" path
     * rather than an empty analytics screen, because an empty chart and a
     * locked feature look identical and mean opposite things.
     */
    analyticsUnlockedAt: timestamp("analytics_unlocked_at", {
      withTimezone: true,
    }),
    changeRequestsUnlockedAt: timestamp("change_requests_unlocked_at", {
      withTimezone: true,
    }),
    managementPausedAt: timestamp("management_paused_at", {
      withTimezone: true,
    }),
    managementPausedReason: text("management_paused_reason"),
    /** Set when an operator deliberately exempts a client from the ladder. */
    /**
     * Treat this client as being on this plan, regardless of what they pay.
     *
     * For the cases a payments table cannot express: family, a friend of the
     * business, someone owed an apology, a client who paid cash before the
     * portal existed, or a beta tester. Without it the only route to an
     * unlocked account is a confirmed payment, which makes those clients
     * unserviceable rather than free.
     *
     * Deliberately a plan reference and not a boolean. "Free" is not one
     * thing — it matters whether someone gets three changes a month or
     * unlimited — and reusing the plan table means a comp cannot describe a
     * package that does not exist.
     *
     * Null means no override: entitlements follow payment, which is the
     * ordinary case and the safe default.
     */
    compPlanId: uuid("comp_plan_id").references(() => servicePlans.id, {
      onDelete: "set null",
    }),

    /** Why. Required in the UI, because "why is this free?" is asked later. */
    compNote: text("comp_note"),

    dunningExemptUntil: timestamp("dunning_exempt_until", {
      withTimezone: true,
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

    /**
     * Changes included per calendar month. Zero is a legitimate value — a
     * hosting-only plan includes none — so "unlimited" is `null` rather than a
     * sentinel like -1, which would silently pass a `>= 0` check and then
     * compare wrongly against a used count.
     */
    includedChangesPerMonth: integer("included_changes_per_month"),
    /** What a change beyond the allowance costs. Null means "not offered". */
    overagePerChangeCents: integer("overage_per_change_cents"),
    /** Whether the analytics dashboard is part of this plan at all. */
    includesAnalytics: boolean("includes_analytics").notNull().default(true),

    /**
     * Square catalogue subscription plan *variation* id, when the plan is
     * billable through Square. Not a secret — it is an opaque catalogue
     * reference, useless without the access token.
     *
     * Deliberately configuration rather than something the portal creates:
     * generating catalogue objects would add a large API surface to automate a
     * task done once per plan, in a dashboard, in five minutes.
     */
    squarePlanVariationId: text("square_plan_variation_id"),

    sortOrder: integer("sort_order").notNull().default(0),
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
    check(
      "service_plans_included_changes_non_negative",
      sql`${t.includedChangesPerMonth} IS NULL OR ${t.includedChangesPerMonth} >= 0`,
    ),
    check(
      "service_plans_overage_non_negative",
      sql`${t.overagePerChangeCents} IS NULL OR ${t.overagePerChangeCents} >= 0`,
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

    /**
     * The processor holding the recurring mandate, when there is one.
     *
     * `recurringEnabledAt` records that the *client* turned on automatic
     * payments, which is a separate fact from the subscription existing: a
     * client can be on a monthly plan and still pay by hand each month. The
     * dunning ladder needs to know the difference, because chasing someone
     * whose card is on file means something has failed, not that they forgot.
     */
    provider: text("provider"),
    providerSubscriptionId: text("provider_subscription_id"),
    recurringEnabledAt: timestamp("recurring_enabled_at", {
      withTimezone: true,
    }),

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
 * One client's change allowance for one calendar month.
 *
 * A row is created lazily on the first submission of a period and never
 * back-filled, so the table records months in which something actually
 * happened rather than a row per client per month forever.
 *
 * `included` is **copied** from the plan at period creation rather than joined
 * at read time. A mid-month plan change must not retroactively alter how many
 * changes a client already had — someone who used three of three and then
 * downgraded to a one-change plan has not suddenly overspent by two.
 */
export const changeAllowances = pgTable(
  "change_allowances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    /** First day of the period, in the business timezone. The period key. */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** Null means unlimited, matching `service_plans`. */
    included: integer("included"),
    used: integer("used").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The uniqueness that makes the atomic claim-or-refuse upsert possible.
    uniqueIndex("change_allowances_client_period_key").on(
      t.clientId,
      t.periodStart,
    ),
    check("change_allowances_used_non_negative", sql`${t.used} >= 0`),
    check(
      "change_allowances_included_non_negative",
      sql`${t.included} IS NULL OR ${t.included} >= 0`,
    ),
    check(
      "change_allowances_period_order",
      sql`${t.periodEnd} >= ${t.periodStart}`,
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

/**
 * A request for payment — an invoice.
 *
 * Separate from `payments` because the two answer different questions: this is
 * "we asked for $X", `payments` is "$X arrived". Off-platform rails such as
 * Venmo give no confirmation callback, so the gap between them is real and the
 * schema models it rather than pretending otherwise.
 *
 * `reference` is the reconciliation key. It goes in the Venmo note, and it is
 * how the operator matches an arriving payment to the request that caused it.
 */
export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    /** Short human-quotable code, e.g. `MW-7F3K`. Appears in the Venmo note. */
    reference: text("reference").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    coversPeriodStart: date("covers_period_start"),
    coversPeriodEnd: date("covers_period_end"),
    dueOn: date("due_on"),

    status: paymentRequestStatusEnum("status").notNull().default("open"),
    method: paymentMethodEnum("method"),

    /**
     * Hosted checkout, when the request is payable through a processor.
     *
     * `checkoutUrl` is stored rather than regenerated per page load because
     * Square's payment links are durable objects with their own ids — minting a
     * fresh one each time the client opens the billing page would leave a trail
     * of orphaned links and make reconciliation ambiguous when two of them are
     * paid.
     *
     * `providerReference` is whatever the processor calls this request on their
     * side (a payment link id). The *payment* that eventually arrives carries
     * its own reference in `payments.providerReference`; these are different
     * objects and conflating them is how a refund gets matched to the wrong row.
     */
    provider: text("provider"),
    providerReference: text("provider_reference"),
    checkoutUrl: text("checkout_url"),

    /**
     * What this request buys. `extra_change` is the one that does something on
     * confirmation: it raises that month's allowance by one, which is why it
     * must be recorded at creation rather than worked out afterwards.
     */
    purpose: paymentPurposeEnum("purpose").notNull().default("subscription"),

    /**
     * Set when the client presses "Pay with Venmo". It records intent only —
     * the client opened the payment app — and never that money moved. Only an
     * operator confirming receipt does that.
     */
    initiatedAt: timestamp("initiated_at", { withTimezone: true }),
    /** The operator confirming funds actually arrived. */
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Links to the ledger row created when the operator confirms. */
    paymentId: uuid("payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),

    /** Highest rung of the reminder ladder reached. Never moves backwards. */
    dunningStage: dunningStageEnum("dunning_stage").notNull().default("none"),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),

    note: text("note"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_requests_public_id_key").on(t.publicId),
    uniqueIndex("payment_requests_reference_key").on(t.reference),
    index("payment_requests_client_status_idx").on(t.clientId, t.status),
    index("payment_requests_due_idx").on(t.dueOn),
    check("payment_requests_amount_positive", sql`${t.amountCents} > 0`),
    // "Paid" is only reachable with a named human attached to the claim.
    check(
      "payment_requests_paid_requires_confirmation",
      sql`${t.status} <> 'paid' OR (${t.confirmedAt} IS NOT NULL AND ${t.confirmedByUserId} IS NOT NULL)`,
    ),
    check(
      "payment_requests_period_order",
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
