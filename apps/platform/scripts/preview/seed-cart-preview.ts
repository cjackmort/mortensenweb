/**
 * Seed a local database for previewing the cart, the Plan tab's one-click
 * cancel and the operator's onboarding card.
 *
 *   PREVIEW_PASSWORD=… npm run db:seed:cart --workspace apps/platform
 *
 * Local PGlite only: it refuses when DATABASE_URL is set, because every
 * account it makes shares one password. Pair it with the Stripe stand-in
 * (`npm run stripe:fake`) and these in `apps/platform/.env.local`:
 * `STRIPE_SECRET_KEY=sk_test_preview`, `STRIPE_API_BASE=http://localhost:12111`.
 *
 * Three demo clients (flagged `is_demo`):
 *  - Juniper Landscaping — password set, website unpaid: the cart.
 *  - Sagebrush Bakery — paying by card for Lite plus review requests: the Plan tab.
 *  - Red Rock Plumbing — demo emailed and login sent: the onboarding card.
 * Plus an admin, cart-preview-admin@example.test. Re-running replaces them.
 */

import { eq, inArray } from "drizzle-orm";
import { BUILDS } from "@mortensenweb/plans";
import { getDb } from "../../src/db/client";
import {
  clientAddOns,
  clients,
  organizationMemberships,
  organizations,
  payments,
  servicePlans,
  subscriptions,
  users,
} from "../../src/db/schema";
import { temporaryPasswordExpiry } from "../../src/lib/auth/credentials";
import { hashPassword } from "../../src/lib/auth/password";
import { newPublicId } from "../../src/lib/ids";
import { PREVIEW, previewPeriodEnd } from "./fixtures";

const DAY = 86_400_000;
const SLUGS = ["juniper-landscaping-preview", "sagebrush-bakery-preview", "red-rock-plumbing-preview"];
const EMAILS = ["cart-preview-admin@example.test", "juniper@example.test", "sagebrush@example.test", "redrock@example.test"];

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    console.error("Refusing to seed preview accounts into DATABASE_URL. This is for local PGlite only.");
    process.exit(1);
  }
  const password = process.env.PREVIEW_PASSWORD;
  if (!password || password.length < 12) {
    console.error("Set PREVIEW_PASSWORD (12+ characters). Every preview account signs in with it.");
    process.exit(1);
  }

  const db = await getDb();
  const passwordHash = await hashPassword(password);
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  // Replace an earlier run's rows.
  const oldOrgs = await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.slug, SLUGS));
  if (oldOrgs.length) {
    const ids = oldOrgs.map((o) => o.id);
    const oldClients = await db.select({ id: clients.id }).from(clients).where(inArray(clients.organizationId, ids));
    if (oldClients.length) await db.delete(payments).where(inArray(payments.clientId, oldClients.map((c) => c.id)));
    await db.delete(organizations).where(inArray(organizations.id, ids));
  }
  await db.delete(users).where(inArray(users.email, EMAILS));

  await db.insert(users).values({
    publicId: newPublicId(),
    email: EMAILS[0]!,
    name: "Jordan (preview)",
    role: "admin",
    status: "active",
    passwordHash,
    passwordAlgo: "pbkdf2-sha256",
    passwordUpdatedAt: new Date(),
    activatedAt: new Date(),
  });

  async function client(input: {
    name: string;
    slug: string;
    email: string;
    contact: string;
    user: Partial<typeof users.$inferInsert>;
    record: Partial<typeof clients.$inferInsert>;
  }) {
    const [org] = await db
      .insert(organizations)
      .values({ publicId: newPublicId(), name: input.name, slug: input.slug, kind: "client", timezone: "America/Denver", isDemo: true })
      .returning();
    const [user] = await db
      .insert(users)
      .values({ publicId: newPublicId(), email: input.email, name: input.contact, role: "client", status: "active", passwordHash, passwordAlgo: "pbkdf2-sha256", passwordUpdatedAt: new Date(), isDemo: true, ...input.user })
      .returning();
    await db.insert(organizationMemberships).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
    const [row] = await db
      .insert(clients)
      .values({ publicId: newPublicId(), organizationId: org!.id, primaryContactName: input.contact, primaryContactEmail: input.email, isDemo: true, ...input.record })
      .returning();
    return row!;
  }

  const build = BUILDS.find((b) => b.priceCents === 50000) ?? BUILDS[0]!;

  const juniper = await client({
    name: "Juniper Landscaping",
    slug: SLUGS[0]!,
    email: EMAILS[1]!,
    contact: "Dana",
    user: { invitedAt: ago(2), activatedAt: ago(1) },
    record: { buildKey: build.key, demoUrl: "https://juniper-landscaping-demo.netlify.app/", demoSentAt: ago(5) },
  });

  const sagebrush = await client({
    name: "Sagebrush Bakery",
    slug: SLUGS[1]!,
    email: EMAILS[2]!,
    contact: "Sam",
    user: { invitedAt: ago(40), activatedAt: ago(39) },
    record: { buildKey: build.key, buildPaidAt: ago(30), stripeCustomerId: PREVIEW.paying.customer, analyticsUnlockedAt: ago(30), changeRequestsUnlockedAt: ago(30) },
  });
  const [lite] = await db.select({ id: servicePlans.id }).from(servicePlans).where(eq(servicePlans.key, PREVIEW.paying.planKey));
  const [sub] = await db
    .insert(subscriptions)
    .values({
      publicId: newPublicId(),
      clientId: sagebrush.id,
      planId: lite!.id,
      monthlyPriceCents: 2500,
      startedOn: ago(30).toISOString().slice(0, 10),
      provider: "stripe",
      providerSubscriptionId: PREVIEW.paying.subscription,
      providerStatus: "active",
      currentPeriodEnd: previewPeriodEnd(),
      recurringEnabledAt: ago(30),
    })
    .returning();
  await db.insert(clientAddOns).values({ clientId: sagebrush.id, featureKey: PREVIEW.paying.addOnKey, source: "stripe", stripeSubscriptionItemId: PREVIEW.paying.addOnItem, monthlyPriceCents: 3500 });
  await db.insert(payments).values({ publicId: newPublicId(), clientId: sagebrush.id, subscriptionId: sub!.id, amountCents: build.priceCents + 6000, method: "stripe", provider: "stripe", receivedOn: ago(30).toISOString().slice(0, 10), isDemo: true });

  const redRock = await client({
    name: "Red Rock Plumbing",
    slug: SLUGS[2]!,
    email: EMAILS[3]!,
    contact: "Riley",
    user: { mustChangePassword: true, tempPasswordExpiresAt: temporaryPasswordExpiry(), invitedAt: ago(1) },
    record: { buildKey: build.key, demoUrl: "https://red-rock-plumbing-demo.netlify.app/", demoSentAt: ago(3) },
  });

  console.log(
    JSON.stringify({
      accounts: { admin: EMAILS[0], cart: EMAILS[1], plan: EMAILS[2], onboarding: EMAILS[3] },
      clients: { juniper: juniper.publicId, sagebrush: sagebrush.publicId, redRock: redRock.publicId },
    }),
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
