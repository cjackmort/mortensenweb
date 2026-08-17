import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import {
  connectionModeEnum,
  deploymentStatusEnum,
  environmentKindEnum,
  previewUrlStyleEnum,
  readinessStatusEnum,
  siteStatusEnum,
} from "./enums";

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    primaryDomain: text("primary_domain"),
    status: siteStatusEnum("status").notNull().default("draft"),

    /** Pinned at scaffold time. A theme update never changes a live site. */
    themeKey: text("theme_key"),
    themeVersion: text("theme_version"),

    /**
     * The Netlify site this deploys to.
     *
     * `netlifySiteName` is not decorative: deploy-preview URLs are built from
     * it (`pr-<n>--<name>.netlify.app`), so it is the input to every preview
     * link the client is ever shown. Storing the id alone would mean an API
     * round trip to construct a URL we already know the shape of.
     */
    netlifySiteId: text("netlify_site_id"),

    /**
     * Defaults to the convention our own template uses, so a scaffolded site
     * needs no thought. Only a repository connected in place — one Netlify
     * already builds from Git — differs.
     */
    previewUrlStyle: previewUrlStyleEnum("preview_url_style")
      .notNull()
      .default("pr_alias"),
    netlifySiteName: text("netlify_site_name"),
    /** Where the site actually serves once live. Set at launch, not at setup. */
    productionUrl: text("production_url"),

    /**
     * The DNS records the client has to create, exactly as sent to them.
     *
     * Stored rather than recomputed so that "what did we tell them to do?" has
     * one answer months later, when they call because something is broken and
     * the recommended record for their setup has since changed.
     */
    dnsRecords: jsonb("dns_records"),
    dnsInstructionsSentAt: timestamp("dns_instructions_sent_at", {
      withTimezone: true,
    }),

    /**
     * When the production URL was last confirmed to actually serve the site.
     * A launch is not complete because a deploy succeeded — DNS propagation and
     * certificate issue both happen after that and both can fail.
     */
    liveVerifiedAt: timestamp("live_verified_at", { withTimezone: true }),

    /** Production launch is gated on an explicit approval, never a config flag. */
    launchApprovedAt: timestamp("launch_approved_at", { withTimezone: true }),
    launchApprovedBy: uuid("launch_approved_by").references(() => users.id, {
      onDelete: "set null",
    }),

    /** Portfolio gate. The public query hard-filters on this column. */
    publicDisplayApproved: boolean("public_display_approved")
      .notNull()
      .default(false),

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
    uniqueIndex("sites_public_id_key").on(t.publicId),
    index("sites_org_idx").on(t.organizationId, t.createdAt),
    index("sites_status_idx").on(t.status),
    check(
      "sites_launch_requires_approver",
      sql`(${t.launchApprovedAt} IS NULL) = (${t.launchApprovedBy} IS NULL)`,
    ),
  ],
);

export const siteEnvironments = pgTable(
  "site_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    kind: environmentKindEnum("kind").notNull(),
    url: text("url"),
    /** Defaults to false: a new environment is non-indexable until proven safe. */
    isIndexable: boolean("is_indexable").notNull().default(false),
    cfWorkerName: text("cf_worker_name"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("site_environments_site_kind_key").on(t.siteId, t.kind),
    index("site_environments_site_idx").on(t.siteId),
  ],
);

export const repositoryConnections = pgTable(
  "repository_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /**
     * The webhook allowlist key. Repository names can be changed by a third
     * party; node IDs cannot, so identity checks use this column.
     */
    repoNodeId: text("repo_node_id"),
    installationId: text("installation_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    connectionMode: connectionModeEnum("connection_mode")
      .notNull()
      .default("managed"),
    /** No webhook is processed and no issue dispatched unless this is true. */
    allowlisted: boolean("allowlisted").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("repository_connections_public_id_key").on(t.publicId),
    uniqueIndex("repository_connections_owner_name_key").on(t.owner, t.name),
    uniqueIndex("repository_connections_node_id_key").on(t.repoNodeId),
    index("repository_connections_site_idx").on(t.siteId),
  ],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").references(() => siteEnvironments.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id"),
    commitSha: text("commit_sha"),
    status: deploymentStatusEnum("status").notNull().default("queued"),
    url: text("url"),
    error: text("error"),
    isRollback: boolean("is_rollback").notNull().default(false),
    rolledBackFromId: uuid("rolled_back_from_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("deployments_public_id_key").on(t.publicId),
    index("deployments_site_time_idx").on(t.siteId, t.startedAt),
    index("deployments_status_idx").on(t.status),
  ],
);

export const analyticsConnections = pgTable(
  "analytics_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("umami"),
    /** One Umami website ID per site. The API key is never stored here. */
    umamiWebsiteId: text("umami_website_id"),
    status: text("status").notNull().default("disconnected"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("analytics_connections_site_key").on(t.siteId),
    index("analytics_connections_website_idx").on(t.umamiWebsiteId),
  ],
);

export const automationReadinessChecks = pgTable(
  "automation_readiness_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    checkKey: text("check_key").notNull(),
    status: readinessStatusEnum("status").notNull().default("unknown"),
    detail: jsonb("detail"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("automation_readiness_site_check_key").on(t.siteId, t.checkKey),
    index("automation_readiness_status_idx").on(t.status),
  ],
);
