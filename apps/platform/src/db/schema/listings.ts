import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity";
import { sites } from "./sites";
import { LISTING_STEP_KEYS } from "../../lib/listings/steps";

/**
 * Get listed: where each site stands on the directories a business has to
 * be in once it is live (`src/lib/listings/steps.ts` is the list).
 *
 * One row per site and step, written the first time anyone touches that
 * step. A step with no row is not done. The row says who marked it and when,
 * so the client page can say "done by Mortensen Web, Oct 12" and the operator
 * can see what the client ticked themselves.
 *
 * `organization_id` is denormalised from the site so the client repository
 * can scope on it directly, like every other client-facing table.
 */

export const LISTING_STEP_STATES = ["todo", "done"] as const;
export type ListingStepState = (typeof LISTING_STEP_STATES)[number];

export const listingSteps = pgTable(
  "listing_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    state: text("state").notNull().default("todo"),
    /** A reminder or the listing's URL, from whoever marked it. */
    note: text("note"),
    markedBy: uuid("marked_by").references(() => users.id, { onDelete: "set null" }),
    markedAt: timestamp("marked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("listing_steps_site_step_key").on(t.siteId, t.stepKey),
    index("listing_steps_org_idx").on(t.organizationId),
    check(
      "listing_steps_step_known",
      sql`${t.stepKey} IN (${sql.join(
        LISTING_STEP_KEYS.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    ),
    check("listing_steps_state_known", sql`${t.state} IN ('todo', 'done')`),
    check("listing_steps_note_short", sql`${t.note} IS NULL OR length(${t.note}) <= 500`),
  ],
);
