import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";

/**
 * The monthly report: what the site did for the business last month.
 *
 * Stored as a snapshot rather than recomputed on view. A report is a record of
 * what the client was told on the 1st — analytics providers revise and expire
 * figures, and a client deletes leads — so recomputing would make last
 * March's report quietly disagree with the email it was sent in. `data` is
 * the whole report as `lib/reports/types.ts` defines it, versioned inside.
 *
 * One row per organization and calendar month (`YYYY-MM`, business timezone).
 * The unique index is also what makes the scheduled build send one email:
 * two overlapping runs both build, only the insert that wins sends.
 */
export const monthlyReports = pgTable(
  "monthly_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `YYYY-MM`. Also the report's URL segment. */
    period: text("period").notNull(),
    data: jsonb("data").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * What happened to the summary email, last time one was attempted.
     * `skipped` is a server with no mail key (development); `opted_out` and
     * `no_recipient` are decisions, not failures. Null: never attempted.
     */
    emailStatus: text("email_status"),
    /** When the email last actually went out. Never set by a skip. */
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    emailError: text("email_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("monthly_reports_org_period_key").on(t.organizationId, t.period),
    check("monthly_reports_period_format", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("monthly_reports_data_object", sql`jsonb_typeof(${t.data}) = 'object'`),
    check(
      "monthly_reports_email_status_known",
      sql`${t.emailStatus} IS NULL OR ${t.emailStatus} IN ('sent', 'skipped', 'failed', 'opted_out', 'no_recipient')`,
    ),
  ],
);

/**
 * Whether a client wants the monthly email. No row means yes.
 *
 * Its own table rather than a column on `clients` so turning the email off
 * records who did it — the client from their reports page, or the operator
 * on their behalf — and so a client who opts out keeps their reports: only
 * the email stops.
 */
export const monthlyReportPreferences = pgTable("monthly_report_preferences", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Set: no monthly email. Null: emails on. */
  emailsOffAt: timestamp("emails_off_at", { withTimezone: true }),
  emailsOffBy: uuid("emails_off_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
