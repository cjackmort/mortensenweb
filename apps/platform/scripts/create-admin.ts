import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { organizations, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { hashPassword } from "@/lib/auth/password";
import {
  generateTemporaryPassword,
  temporaryPasswordExpiry,
} from "@/lib/auth/credentials";

/**
 * Create the first admin account.
 *
 * Separate from `seed.ts` on purpose. The seed exists to make a *development*
 * database interesting and creates roughly ten `is_demo` rows — "Northwind
 * Comfort Systems (DEMO)" and friends — alongside the admin. Running it against
 * production to obtain a login would put fictional clients into the real
 * database, which is why it refuses to run there at all.
 *
 * This script creates exactly two rows: the agency organization, and one admin
 * user holding a generated temporary password that must be changed at first
 * sign-in. Nothing here is flagged demo, and nothing else is created.
 *
 *   DATABASE_URL=postgres://... ADMIN_EMAIL=you@example.com \
 *     npx tsx scripts/create-admin.ts
 *
 * Safe to re-run: it refuses rather than issuing a second credential for an
 * address that already has an account.
 */

const AGENCY_NAME = "Mortensen Web Co.";
const AGENCY_SLUG = "mortensen-web";

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error(
      "ADMIN_EMAIL must be set to the address this admin will sign in with.",
    );
    process.exit(1);
  }

  const db = await getDb();

  const existing = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing[0]) {
    // Reissuing a credential for an existing account is a different, deliberate
    // operation — doing it silently here would be an account-takeover path.
    console.error(
      `${email} already has an account. Use the portal's reissue action, or the ` +
        `password reset flow, rather than re-running this script.`,
    );
    process.exit(1);
  }

  let agency = (
    await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, AGENCY_SLUG))
      .limit(1)
  )[0];

  if (!agency) {
    agency = (
      await db
        .insert(organizations)
        .values({
          publicId: newPublicId(),
          name: AGENCY_NAME,
          slug: AGENCY_SLUG,
          kind: "agency",
          timezone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
        })
        .returning({ id: organizations.id })
    )[0]!;
    console.log(`Created organization ${AGENCY_NAME}.`);
  }

  const temporaryPassword = generateTemporaryPassword();
  const expiresAt = temporaryPasswordExpiry();
  const now = new Date();

  await db.insert(users).values({
    publicId: newPublicId(),
    email,
    name: null,
    role: "admin",
    status: "active",
    passwordHash: await hashPassword(temporaryPassword),
    passwordAlgo: "pbkdf2-sha256",
    passwordUpdatedAt: now,
    // The check constraint refuses a temporary credential with no expiry.
    mustChangePassword: true,
    tempPasswordExpiresAt: expiresAt,
    invitedAt: now,
  });

  // Printed once, never stored in plaintext, never written to the audit row.
  console.log(`
  Admin created.

    Email:    ${email}
    Password: ${temporaryPassword}

  This is shown once and is not recoverable. It must be changed at first
  sign-in and expires ${expiresAt.toDateString()}.
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
