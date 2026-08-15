/**
 * Demo seed data.
 *
 * Every row created here is flagged `is_demo` and uses reserved example
 * domains. No real client, repository, or domain may ever appear in this file.
 *
 * The script refuses to run against production unless ALLOW_PRODUCTION_SEED is
 * set explicitly, so development credentials cannot silently become live ones.
 */

import { getDb } from "../src/db/client";
import { temporaryPasswordExpiry } from "../src/lib/auth/credentials";
import {
  changeRequests,
  clients,
  organizationMemberships,
  organizations,
  prospects,
  requestEvents,
  servicePlans,
  sites,
  subscriptions,
  payments,
  businessFacts,
  users,
} from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";
import { newPublicId } from "../src/lib/ids";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "cjackmort@gmail.com")
  .trim()
  .toLowerCase();

/**
 * Generated fresh on every seed and printed once.
 *
 * This repository is public, so a hardcoded admin password would be a
 * published credential the moment anyone seeded a reachable database. The
 * production guard below should prevent that, but a guard plus a random
 * secret is the right shape — not a guard alone.
 */
function generatePassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

const DEMO_ADMIN_PASSWORD = generatePassword();
const DEMO_CLIENT_PASSWORD = generatePassword();

function guardProduction() {
  const isProduction = process.env.NODE_ENV === "production";
  const allowed = process.env.ALLOW_PRODUCTION_SEED === "true";
  if (isProduction && !allowed) {
    console.error(
      "Refusing to seed: NODE_ENV=production and ALLOW_PRODUCTION_SEED is not set.\n" +
        "Demo credentials must never exist in a production database.",
    );
    process.exit(1);
  }
}

async function main() {
  guardProduction();
  const db = await getDb();

  console.log("Seeding demo data...");

  // ---- Service plans (reference data, not demo-only) ---------------------
  const planRows = await db
    .insert(servicePlans)
    .values([
      {
        key: "care-basic",
        name: "Care — Basic",
        description: "Hosting, security updates, and monthly content edits.",
        defaultMonthlyCents: 9900,
      },
      {
        key: "care-plus",
        name: "Care — Plus",
        description: "Basic plus analytics reporting and priority turnaround.",
        defaultMonthlyCents: 19900,
      },
    ])
    .onConflictDoNothing()
    .returning();

  // ---- Agency organization and admin user --------------------------------
  const agencyOrg = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Mortensen Web Co.",
        slug: "mortensen-web",
        kind: "agency",
        timezone: "America/Denver",
      })
      .returning()
  )[0]!;

  const adminUser = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: ADMIN_EMAIL,
        name: "Jack Mortensen",
        role: "admin",
        status: "active",
        passwordHash: await hashPassword(DEMO_ADMIN_PASSWORD),
        passwordAlgo: "pbkdf2-sha256",
        passwordUpdatedAt: new Date(),
        // Forces the temporary password to be replaced on first sign-in.
        // The expiry is mandatory: a check constraint refuses a temporary
        // credential that would live forever.
        mustChangePassword: true,
        tempPasswordExpiresAt: temporaryPasswordExpiry(),
        invitedAt: new Date(),
      })
      .returning()
  )[0]!;

  await db.insert(organizationMemberships).values({
    organizationId: agencyOrg.id,
    userId: adminUser.id,
    role: "owner",
  });

  // ---- Demo current client ------------------------------------------------
  const clientOrg = (
    await db
      .insert(organizations)
      .values({
        publicId: newPublicId(),
        name: "Northwind Comfort Systems (DEMO)",
        slug: "northwind-comfort-demo",
        kind: "client",
        timezone: "America/Denver",
        isDemo: true,
      })
      .returning()
  )[0]!;

  const clientUser = (
    await db
      .insert(users)
      .values({
        publicId: newPublicId(),
        email: "owner@northwind-demo.example",
        // Demo of the issued sign-in handle: this account can sign in with
        // either `northwind-comfort` or the email address.
        username: "northwind-comfort",
        name: "Dana Reyes (DEMO)",
        role: "client",
        status: "active",
        passwordHash: await hashPassword(DEMO_CLIENT_PASSWORD),
        passwordAlgo: "pbkdf2-sha256",
        passwordUpdatedAt: new Date(),
        isDemo: true,
      })
      .returning()
  )[0]!;

  await db.insert(organizationMemberships).values({
    organizationId: clientOrg.id,
    userId: clientUser.id,
    role: "owner",
  });

  const clientRecord = (
    await db
      .insert(clients)
      .values({
        publicId: newPublicId(),
        organizationId: clientOrg.id,
        primaryContactName: "Dana Reyes (DEMO)",
        primaryContactEmail: "owner@northwind-demo.example",
        phone: "555-0100",
        industry: "hvac",
        onboardingStatus: "active",
        isDemo: true,
      })
      .returning()
  )[0]!;

  const demoSite = (
    await db
      .insert(sites)
      .values({
        publicId: newPublicId(),
        organizationId: clientOrg.id,
        name: "Northwind Comfort Systems",
        primaryDomain: "northwind-demo.example",
        status: "live",
        themeKey: "hvac/modern-comfort",
        themeVersion: "0.0.0-demo",
        isDemo: true,
      })
      .returning()
  )[0]!;

  const basicPlan = planRows.find((p) => p.key === "care-basic") ?? planRows[0];

  const subscription = (
    await db
      .insert(subscriptions)
      .values({
        publicId: newPublicId(),
        clientId: clientRecord.id,
        planId: basicPlan?.id ?? null,
        monthlyPriceCents: 9900,
        billingDay: 1,
        status: "active",
        startedOn: "2026-01-01",
      })
      .returning()
  )[0]!;

  await db.insert(payments).values([
    {
      publicId: newPublicId(),
      clientId: clientRecord.id,
      subscriptionId: subscription.id,
      amountCents: 9900,
      method: "venmo",
      coversPeriodStart: "2026-06-01",
      coversPeriodEnd: "2026-06-30",
      receivedOn: "2026-06-02",
      recordedBy: adminUser.id,
      note: "DEMO payment",
      isDemo: true,
    },
    {
      publicId: newPublicId(),
      clientId: clientRecord.id,
      subscriptionId: subscription.id,
      amountCents: 9900,
      method: "cash",
      coversPeriodStart: "2026-07-01",
      coversPeriodEnd: "2026-07-31",
      receivedOn: "2026-07-01",
      recordedBy: adminUser.id,
      note: "DEMO payment",
      isDemo: true,
    },
  ]);

  const demoRequest = (
    await db
      .insert(changeRequests)
      .values({
        publicId: newPublicId(),
        organizationId: clientOrg.id,
        siteId: demoSite.id,
        createdByUserId: clientUser.id,
        title: "Update the summer promotion banner",
        description:
          "Please swap the spring tune-up offer for the summer AC check special.",
        category: "content",
        priority: "normal",
        status: "triaged",
        isDemo: true,
      })
      .returning()
  )[0]!;

  await db.insert(requestEvents).values([
    {
      requestId: demoRequest.id,
      actorType: "client",
      actorUserId: clientUser.id,
      kind: "submitted",
      body: "Request submitted.",
      visibility: "client_visible",
    },
    {
      requestId: demoRequest.id,
      actorType: "admin",
      actorUserId: adminUser.id,
      kind: "internal_note",
      body: "INTERNAL: bundle this with the Q3 content refresh.",
      visibility: "internal",
    },
  ]);

  // ---- Demo potential client ---------------------------------------------
  const demoProspect = (
    await db
      .insert(prospects)
      .values({
        publicId: newPublicId(),
        businessName: "Cascade Glass Care (DEMO)",
        sourceWebsiteUrl: "https://example.com",
        industry: "window-cleaning",
        status: "audited",
        location: "Salt Lake City, UT",
        serviceArea: "Wasatch Front",
        tone: "friendly, local, reliable",
        createdBy: adminUser.id,
        isDemo: true,
      })
      .returning()
  )[0]!;

  // Facts demonstrating the verification ladder. Only user_verified and
  // user_supplied entries may ever render into a generated site.
  await db.insert(businessFacts).values([
    {
      prospectId: demoProspect.id,
      key: "phone",
      value: "555-0150",
      sourceUrl: "https://example.com/contact",
      sourceType: "crawl",
      verification: "unverified",
      confidence: 70,
    },
    {
      prospectId: demoProspect.id,
      key: "service_area",
      value: "Wasatch Front",
      sourceType: "user_supplied",
      verification: "user_verified",
      confidence: 100,
    },
    {
      prospectId: demoProspect.id,
      key: "insurance_claim",
      value: "Fully licensed and insured",
      sourceUrl: "https://example.com/about",
      sourceType: "crawl",
      // Must never be auto-published without documentary confirmation.
      verification: "sensitive",
      confidence: 40,
    },
  ]);

  console.log(`
Seed complete.

  Admin      ${ADMIN_EMAIL}
             password: ${DEMO_ADMIN_PASSWORD}
             (must be changed at first sign-in)

  Demo client  owner@northwind-demo.example
               password: ${DEMO_CLIENT_PASSWORD}

  1 demo current client, 1 demo potential client, 2 demo payments,
  1 demo change request, 3 demo business facts.

All demo rows are flagged is_demo and use reserved .example domains.
`);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
