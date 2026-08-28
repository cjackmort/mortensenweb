/**
 * Remove demo data.
 *
 * The inverse of `seed.ts`. That script inserts its users with a plain
 * `.insert()` and no conflict clause, so a second seed against an already
 * seeded database dies on `users_email_key`. This is the supported way back to
 * a clean slate — the alternative people reach for is deleting `.pglite` by
 * hand, which also discards the applied migrations and the schema with them.
 *
 * Deletes are scoped to `is_demo` wherever the table carries that column, so
 * pointing this at a database that holds real clients removes the fixtures and
 * nothing else. Three tables can refuse a delete outright rather than cascade
 * — `payments`, `prospect_conversions`, and `impersonation_sessions` are all
 * `on delete restrict` — so those are cleared first, and only for the demo
 * rows they hang off. Everything else is reachable by cascade from a demo
 * organization, client, site, or prospect.
 *
 * Two separate opt-ins, because this one destroys data:
 *
 *   --yes                    (or CONFIRM_DESTRUCTIVE_RESET=true) is required
 *                            before the script will touch anything.
 *   --include-seed-accounts  (or RESET_INCLUDE_SEED_ACCOUNTS=true) also removes
 *                            the two rows the seed creates *without* an
 *                            is_demo flag: the agency organization and the
 *                            admin account. Without it the demo data is gone
 *                            but `db:seed` still collides on the admin email.
 *
 * Production is refused the same way `seed.ts` refuses it.
 *
 *   npm run db:reset --workspace apps/platform -- --yes
 *
 * The local database is embedded PGlite at `apps/platform/.pglite`, and PGlite
 * is single-writer: stop `next dev` before running this. A dev server holding
 * the data directory makes the script hang on the lock rather than fail with
 * something that reads like an explanation.
 */

import { eq, inArray, or, type SQL } from "drizzle-orm";

import { getDb } from "../src/db/client";
import {
  changeRequests,
  clients,
  impersonationSessions,
  organizations,
  paymentAdjustments,
  paymentRequests,
  payments,
  prospectConversions,
  prospects,
  sites,
  users,
} from "../src/db/schema";

/** Matches `seed.ts` and `create-admin.ts`, so the same row is targeted. */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "cjackmort@gmail.com")
  .trim()
  .toLowerCase();

const AGENCY_SLUG = "mortensen-web";

const args = process.argv.slice(2);

function hasFlag(flag: string, envVar: string): boolean {
  return args.includes(flag) || process.env[envVar] === "true";
}

function guardProduction() {
  const isProduction = process.env.NODE_ENV === "production";
  const allowed = process.env.ALLOW_PRODUCTION_SEED === "true";
  if (isProduction && !allowed) {
    console.error(
      "Refusing to reset: NODE_ENV=production and ALLOW_PRODUCTION_SEED is not set.\n" +
        "Deleting rows is not something to discover you can do against production.",
    );
    process.exit(1);
  }
}

/**
 * The production guard alone is not enough here. `seed.ts` adds rows, so the
 * worst case of running it in the wrong terminal is some fictional clients to
 * clean up. This one removes them, and a mistyped target is unrecoverable.
 */
function guardConfirmation() {
  if (hasFlag("--yes", "CONFIRM_DESTRUCTIVE_RESET")) return;
  console.error(
    "Refusing to reset: this deletes rows and nothing confirmed it.\n\n" +
      "  npm run db:reset --workspace apps/platform -- --yes\n\n" +
      "Or set CONFIRM_DESTRUCTIVE_RESET=true.",
  );
  process.exit(1);
}

const removed: Array<{ label: string; count: number }> = [];

function record(label: string, rows: readonly unknown[]): void {
  if (rows.length > 0) removed.push({ label, count: rows.length });
}

async function main() {
  guardProduction();
  guardConfirmation();

  const includeSeedAccounts = hasFlag(
    "--include-seed-accounts",
    "RESET_INCLUDE_SEED_ACCOUNTS",
  );

  const db = await getDb();

  console.log("Removing demo data...");

  // Collected before anything is deleted: these ids are the only handle on the
  // restrict-blocked children, and once the parent row is gone there is
  // nothing left to scope the delete by.
  const demoPaymentIds = (
    await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.isDemo, true))
  ).map((row) => row.id);

  const demoClientIds = (
    await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.isDemo, true))
  ).map((row) => row.id);

  const demoProspectIds = (
    await db
      .select({ id: prospects.id })
      .from(prospects)
      .where(eq(prospects.isDemo, true))
  ).map((row) => row.id);

  const demoUserIds = (
    await db.select({ id: users.id }).from(users).where(eq(users.isDemo, true))
  ).map((row) => row.id);

  // ---- `on delete restrict` children, scoped to their demo parents --------

  if (demoPaymentIds.length > 0) {
    record(
      "payment adjustments",
      await db
        .delete(paymentAdjustments)
        .where(inArray(paymentAdjustments.paymentId, demoPaymentIds))
        .returning({ id: paymentAdjustments.id }),
    );
  }

  // A conversion row restricts both sides — the prospect it came from and the
  // client it became — so either being demo is reason enough to clear it.
  const conversionScopes: SQL[] = [];
  if (demoProspectIds.length > 0) {
    conversionScopes.push(
      inArray(prospectConversions.prospectId, demoProspectIds),
    );
  }
  if (demoClientIds.length > 0) {
    conversionScopes.push(inArray(prospectConversions.clientId, demoClientIds));
  }
  if (conversionScopes.length > 0) {
    record(
      "prospect conversions",
      await db
        .delete(prospectConversions)
        .where(or(...conversionScopes))
        .returning({ id: prospectConversions.id }),
    );
  }

  if (demoUserIds.length > 0) {
    record(
      "impersonation sessions",
      await db
        .delete(impersonationSessions)
        .where(inArray(impersonationSessions.adminUserId, demoUserIds))
        .returning({ id: impersonationSessions.id }),
    );
  }

  // ---- Demo rows, children before parents --------------------------------
  //
  // Each of these drags a subtree down with it by cascade. The counts below
  // are the flagged rows themselves, not the cascaded descendants — reporting
  // a number the script never actually saw would be worse than reporting none.

  record(
    "payment requests",
    await db
      .delete(paymentRequests)
      .where(eq(paymentRequests.isDemo, true))
      .returning({ id: paymentRequests.id }),
  );

  // Before clients: `payments.client_id` is restrict, so a demo payment left
  // standing blocks its own client.
  record(
    "payments",
    await db
      .delete(payments)
      .where(eq(payments.isDemo, true))
      .returning({ id: payments.id }),
  );

  // Cascades request events and attachments.
  record(
    "change requests",
    await db
      .delete(changeRequests)
      .where(eq(changeRequests.isDemo, true))
      .returning({ id: changeRequests.id }),
  );

  // Cascades contacts, audit jobs and their pages, business facts, concept
  // jobs and their repositories, shares.
  record(
    "prospects",
    await db
      .delete(prospects)
      .where(eq(prospects.isDemo, true))
      .returning({ id: prospects.id }),
  );

  // Cascades environments, repository connections, deployments, analytics
  // connections, readiness checks, preview deployments.
  record(
    "sites",
    await db
      .delete(sites)
      .where(eq(sites.isDemo, true))
      .returning({ id: sites.id }),
  );

  // Cascades subscriptions, change allowances, client notes, migration
  // projects and their tasks and audits.
  record(
    "clients",
    await db
      .delete(clients)
      .where(eq(clients.isDemo, true))
      .returning({ id: clients.id }),
  );

  // Cascades memberships, password reset and email verification tokens,
  // notifications.
  record(
    "users",
    await db
      .delete(users)
      .where(eq(users.isDemo, true))
      .returning({ id: users.id }),
  );

  // Last: everything above hangs off an organization one way or another.
  record(
    "organizations",
    await db
      .delete(organizations)
      .where(eq(organizations.isDemo, true))
      .returning({ id: organizations.id }),
  );

  // ---- The seed's unflagged rows, only when asked ------------------------

  if (includeSeedAccounts) {
    const adminIds = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, ADMIN_EMAIL))
    ).map((row) => row.id);

    if (adminIds.length > 0) {
      record(
        "impersonation sessions (admin)",
        await db
          .delete(impersonationSessions)
          .where(inArray(impersonationSessions.adminUserId, adminIds))
          .returning({ id: impersonationSessions.id }),
      );
      record(
        `admin account (${ADMIN_EMAIL})`,
        await db
          .delete(users)
          .where(inArray(users.id, adminIds))
          .returning({ id: users.id }),
      );
    }

    record(
      "agency organization",
      await db
        .delete(organizations)
        .where(eq(organizations.slug, AGENCY_SLUG))
        .returning({ id: organizations.id }),
    );
  }

  // ---- Report -------------------------------------------------------------

  if (removed.length === 0) {
    console.log("\nNothing removed — no demo rows were present.");
  } else {
    const width = Math.max(...removed.map((r) => String(r.count).length));
    console.log("\nRemoved:\n");
    for (const entry of removed) {
      console.log(`  ${String(entry.count).padStart(width)}  ${entry.label}`);
    }
  }

  // Service plans are reference data rather than demo data, and `seed.ts`
  // inserts them with `onConflictDoNothing`, so re-seeding over them is fine.
  console.log("\nService plans were left in place. They are reference data.");

  if (!includeSeedAccounts) {
    const remaining: string[] = [];
    const adminRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL));
    if (adminRows.length > 0) remaining.push(ADMIN_EMAIL);

    const agencyRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, AGENCY_SLUG));
    if (agencyRows.length > 0) {
      remaining.push(`the ${AGENCY_SLUG} organization`);
    }

    if (remaining.length > 0) {
      console.log(`
Still present, because the seed creates them without an is_demo flag:
${remaining.map((item) => `  - ${item}`).join("\n")}

db:seed will collide with these. To clear them too:

  npm run db:reset --workspace apps/platform -- --yes --include-seed-accounts
`);
    }
  }
}

main().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
