import { sql } from "drizzle-orm";
import { check, date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity";
import { sites } from "./sites";

/**
 * What Google Search Console said about a client's site, once a day.
 *
 * One row per site per day, taken by the `searchSnapshotsTaken` cron job
 * from the client's connected Google account (`connected_accounts`, provider
 * `google`). Each row holds the whole 28-day window as Google reported it
 * that day — totals, the top 25 queries and the per-day series — so the
 * Search page can show the trend from the first snapshot rather than after
 * 28 days of rows, and so a figure a client was shown is never recomputed
 * into something else later.
 *
 * A failed fetch still writes the day's row, with `error` set and no data:
 * the page then says "could not fetch" instead of showing an empty table,
 * and the job retries that row on a later tick instead of a new one.
 * `data` is `SearchSnapshot` from `lib/connections/providers/google.ts`.
 */
export const searchSnapshots = pgTable(
  "search_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** The calendar day the snapshot was taken (UTC), not the window it covers. */
    takenOn: date("taken_on").notNull(),
    /** The Search Console property the figures came from; null when the site was not found. */
    property: text("property"),
    /** Null while the fetch has not succeeded. */
    data: jsonb("data"),
    error: text("error"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("search_snapshots_site_day_key").on(t.siteId, t.takenOn),
    index("search_snapshots_org_day_idx").on(t.organizationId, t.takenOn),
    check("search_snapshots_data_object", sql`${t.data} IS NULL OR jsonb_typeof(${t.data}) = 'object'`),
    // A row is either fetched (data, no error) or failed (error, no data); never both, never neither.
    check(
      "search_snapshots_outcome",
      sql`(${t.data} IS NOT NULL AND ${t.error} IS NULL AND ${t.fetchedAt} IS NOT NULL) OR (${t.data} IS NULL AND ${t.error} IS NOT NULL)`,
    ),
  ],
);
