import { sql } from "drizzle-orm";
import {
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

/**
 * Accounts a client has connected so the portal can look them over —
 * Stripe, Google Search Console, Instagram — and what it found last time.
 * Also Google Calendar, connected from Availability and read only for busy
 * times (`lib/connections/providers/google-calendar.ts`).
 *
 * One row per organization and provider while connected. Tokens are sealed
 * (`lib/connections/seal.ts`) and never leave the server; what the client
 * sees is the audit: a snapshot of the numbers and the findings drawn from
 * them, which the monthly report repeats. A disconnect keeps the row with
 * `revoked_at` set and its tokens cleared, so the history of what was
 * connected survives and a reconnect is a new row.
 */

export const CONNECTION_PROVIDERS = ["stripe", "google", "instagram", "google_calendar"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const CONNECTION_STATUSES = ["connected", "needs_reconnect", "revoked"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ConnectionProvider>().notNull(),
    /** The account at the provider: `acct_…`, a Google subject, an Instagram user id. */
    externalId: text("external_id").notNull(),
    /** What the client recognises it by: the business on the Stripe account, an email, an @handle. */
    displayName: text("display_name"),
    scope: text("scope").notNull().default(""),
    /** Sealed. Google's short-lived access token, Instagram's long-lived one, Stripe's restricted key. */
    accessTokenSealed: text("access_token_sealed"),
    /** Sealed. Google's refresh token. Null where the provider issues none. */
    refreshTokenSealed: text("refresh_token_sealed"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    status: text("status").$type<ConnectionStatus>().notNull().default("connected"),
    connectedBy: uuid("connected_by").references(() => users.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** The last look: snapshot, findings and the rows the report shows. `lib/connections/types.ts`. */
    lastAudit: jsonb("last_audit"),
    lastAuditAt: timestamp("last_audit_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connected_accounts_public_id_key").on(t.publicId),
    // One live connection per provider per client. Revoked rows stay as history.
    uniqueIndex("connected_accounts_live_key")
      .on(t.organizationId, t.provider)
      .where(sql`${t.revokedAt} IS NULL`),
    index("connected_accounts_audit_due_idx").on(t.status, t.lastAuditAt),
    check(
      "connected_accounts_provider",
      sql`${t.provider} IN ('stripe', 'google', 'instagram', 'google_calendar')`,
    ),
    check(
      "connected_accounts_status",
      sql`${t.status} IN ('connected', 'needs_reconnect', 'revoked')`,
    ),
    check(
      "connected_accounts_audit_object",
      sql`${t.lastAudit} IS NULL OR jsonb_typeof(${t.lastAudit}) = 'object'`,
    ),
  ],
);
