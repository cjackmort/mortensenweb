import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  membershipRoleEnum,
  organizationKindEnum,
  userRoleEnum,
  userStatusEnum,
} from "./enums";

/**
 * Identity, tenancy, and audit.
 *
 * `organizations` is the tenancy boundary. Every client-facing row in the
 * system is reachable only through an organization the session belongs to.
 */

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 128-bit random, base32. The only identifier exposed in URLs and APIs. */
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: organizationKindEnum("kind").notNull().default("client"),
    timezone: text("timezone").notNull().default("America/Denver"),
    /** Demo rows are seeded for development and must be visibly labelled. */
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
    uniqueIndex("organizations_public_id_key").on(t.publicId),
    uniqueIndex("organizations_slug_key").on(t.slug),
    index("organizations_kind_idx").on(t.kind),
    check("organizations_slug_lowercase", sql`${t.slug} = lower(${t.slug})`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    /** Always stored lowercased; the check constraint enforces it. */
    email: text("email").notNull(),
    name: text("name"),

    /** PHC-style string, e.g. `$pbkdf2-sha256$i=600000$<salt>$<hash>`. */
    passwordHash: text("password_hash"),
    /** Recorded separately so the KDF can be migrated without a flag day. */
    passwordAlgo: text("password_algo"),
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
    mustChangePassword: boolean("must_change_password")
      .notNull()
      .default(false),

    role: userRoleEnum("role").notNull().default("client"),
    status: userStatusEnum("status").notNull().default("invited"),

    /**
     * Session revocation. Embedded in the JWT and compared on every request.
     * Incrementing this invalidates every outstanding token for the user.
     */
    sessionEpoch: integer("session_epoch").notNull().default(0),

    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

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
    uniqueIndex("users_public_id_key").on(t.publicId),
    uniqueIndex("users_email_key").on(t.email),
    index("users_role_status_idx").on(t.role, t.status),
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    check(
      "users_failed_login_non_negative",
      sql`${t.failedLoginCount} >= 0`,
    ),
    check("users_session_epoch_non_negative", sql`${t.sessionEpoch} >= 0`),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("organization_memberships_org_user_key").on(
      t.organizationId,
      t.userId,
    ),
    index("organization_memberships_user_idx").on(t.userId),
  ],
);

/**
 * Password reset and email verification.
 *
 * Only the SHA-256 of the token is stored. A database disclosure therefore
 * does not yield a usable reset link.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestedIpHash: text("requested_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_hash_key").on(t.tokenHash),
    index("password_reset_tokens_user_idx").on(t.userId),
    index("password_reset_tokens_expires_idx").on(t.expiresAt),
  ],
);

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_verification_tokens_hash_key").on(t.tokenHash),
    index("email_verification_tokens_user_idx").on(t.userId),
  ],
);

/**
 * Login attempt log, backing rate limiting and account lockout.
 * Identifiers are hashed so the table is not itself a source of PII.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailHash: text("email_hash").notNull(),
    ipHash: text("ip_hash"),
    succeeded: boolean("succeeded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("login_attempts_email_time_idx").on(t.emailHash, t.createdAt),
    index("login_attempts_ip_time_idx").on(t.ipHash, t.createdAt),
  ],
);

/**
 * "View as client" audit. A row is opened on entry and closed on exit, so an
 * unclosed row is itself a signal worth alerting on.
 */
export const impersonationSessions = pgTable(
  "impersonation_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    targetUserId: uuid("target_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    targetOrganizationId: uuid("target_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reason: text("reason"),
    ipHash: text("ip_hash"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("impersonation_sessions_public_id_key").on(t.publicId),
    index("impersonation_sessions_admin_idx").on(t.adminUserId, t.startedAt),
    index("impersonation_sessions_open_idx").on(t.endedAt),
  ],
);

/**
 * General audit trail. The actor reference is `set null` on delete so history
 * survives user removal.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_actor_time_idx").on(t.actorUserId, t.createdAt),
    index("audit_log_org_time_idx").on(t.organizationId, t.createdAt),
  ],
);
