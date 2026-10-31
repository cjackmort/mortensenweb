/**
 * Clients standing at the welcome page, in the local PGlite database only.
 *
 *   npm run seed:welcome --workspace apps/platform
 *
 * - `build`   — nothing raised yet, so the welcome page offers the published
 *               $500 site build (the ordinary new client).
 * - `invoice` — an operator has already raised a $500 invoice for the build, so
 *               the page shows that invoice and a plan can be chosen beside it.
 *               This is the only way a plan gets paid without the build.
 * - `live`    — like `build`, for decision D1's own path: look at the built
 *               preview, then "Put it live" for the build alone.
 * - `code`    — like `live`, paid with a 100%-off build code.
 *
 * Each has its site's Netlify address recorded, as a scaffolded site does,
 * so the welcome page shows the preview. Nothing is served there; the page
 * links to it and draws the site's initial where the picture would be.
 *
 * Both have a temporary password and must change it on first sign-in, so the
 * run starts where a real client does. An admin is seeded too: a one-off card
 * payment is settled "as" an admin, and with none the webhook leaves the
 * payment waiting for review.
 *
 * The passwords are generated here and written to a git-ignored file
 * (`.e2e/credentials.json`, or `E2E_CREDENTIALS_FILE`). They are never printed.
 *
 * Refuses to run when `DATABASE_URL` is set to anything. The seed inserts
 * users with known passwords; against a real database that is a backdoor.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BUILD } from "@mortensenweb/plans";
import { getDb } from "../../src/db/client";
import {
  clients,
  organizationMemberships,
  organizations,
  paymentRequests,
  sites,
  users,
} from "../../src/db/schema";
import { temporaryPasswordExpiry } from "../../src/lib/auth/credentials";
import { hashPassword } from "../../src/lib/auth/password";
import { newPublicId } from "../../src/lib/ids";
import { businessDate } from "../../src/lib/billing/period";
import { generatePaymentReference } from "../../src/lib/payments/venmo";

type Role = "admin" | "client";

interface Account {
  identifier: string;
  password: string;
}

const CREDENTIALS_FILE = resolve(process.env.E2E_CREDENTIALS_FILE ?? ".e2e/credentials.json");

const generatePassword = (): string => randomBytes(18).toString("base64url");

function refuseUnlessLocal(): void {
  if (!process.env.DATABASE_URL?.trim()) return;
  console.error(
    "Refusing to seed: DATABASE_URL is set.\n" +
      "This seed creates logins with known passwords and only ever runs against the local PGlite database.\n" +
      "Unset DATABASE_URL (it is read from the shell, not from .env.local, by this script) and run it again.",
  );
  process.exit(1);
}

async function createUser(
  db: Awaited<ReturnType<typeof getDb>>,
  input: { role: Role; email: string; username: string | null; name: string; organizationId: string },
): Promise<{ id: string; account: Account }> {
  const password = generatePassword();
  const [user] = await db
    .insert(users)
    .values({
      publicId: newPublicId(),
      email: input.email,
      username: input.username,
      name: input.name,
      role: input.role,
      status: "active",
      passwordHash: await hashPassword(password),
      passwordAlgo: "pbkdf2-sha256",
      passwordUpdatedAt: new Date(),
      // The temporary-password state a real invitation leaves, so the first
      // sign-in goes through "choose your password" and on to the welcome page.
      mustChangePassword: true,
      tempPasswordExpiresAt: temporaryPasswordExpiry(),
      invitedAt: new Date(),
      isDemo: true,
    })
    .returning({ id: users.id });
  await db.insert(organizationMemberships).values({ organizationId: input.organizationId, userId: user!.id, role: "owner" });
  return { id: user!.id, account: { identifier: input.username ?? input.email, password } };
}

async function createOrganization(
  db: Awaited<ReturnType<typeof getDb>>,
  input: { name: string; slug: string; kind: "agency" | "client" },
): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name: input.name, slug: input.slug, kind: input.kind, timezone: "America/Denver", isDemo: true })
    .returning({ id: organizations.id });
  return org!.id;
}

async function createClient(
  db: Awaited<ReturnType<typeof getDb>>,
  input: { label: string; slug: string; withBuildInvoice: boolean },
): Promise<Account> {
  const organizationId = await createOrganization(db, { name: `${input.label} (E2E)`, slug: input.slug, kind: "client" });
  const email = `owner@${input.slug}.example`;
  const owner = await createUser(db, { role: "client", email, username: input.slug, name: `${input.label} Owner`, organizationId });

  const [client] = await db
    .insert(clients)
    .values({
      publicId: newPublicId(),
      organizationId,
      primaryContactName: `${input.label} Owner`,
      primaryContactEmail: email,
      onboardingStatus: "active",
      isDemo: true,
    })
    .returning({ id: clients.id });

  await db.insert(sites).values({
    publicId: newPublicId(),
    organizationId,
    name: input.label,
    primaryDomain: `${input.slug}.example`,
    netlifySiteName: `${input.slug}-e2e`,
    status: "preview",
    isDemo: true,
  });

  if (input.withBuildInvoice) {
    await db.insert(paymentRequests).values({
      publicId: newPublicId(),
      clientId: client!.id,
      reference: generatePaymentReference(),
      amountCents: BUILD.priceCents,
      dueOn: businessDate(),
      note: "Website design and build",
      status: "open",
      purpose: "build",
    });
  }
  return owner.account;
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  const db = await getDb();

  const agencyId = await createOrganization(db, { name: "Mortensen Web Co. (E2E)", slug: "mortensen-web-e2e", kind: "agency" });
  const admin = await createUser(db, { role: "admin", email: "admin@mortensen-web-e2e.example", username: null, name: "E2E Admin", organizationId: agencyId });

  const accounts = {
    admin: admin.account,
    build: await createClient(db, { label: "Welcome Build", slug: "welcome-build", withBuildInvoice: false }),
    invoice: await createClient(db, { label: "Welcome Invoice", slug: "welcome-invoice", withBuildInvoice: true }),
    live: await createClient(db, { label: "Welcome Live", slug: "welcome-live", withBuildInvoice: false }),
    code: await createClient(db, { label: "Welcome Code", slug: "welcome-code", withBuildInvoice: false }),
  };

  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  console.log(`Seeded 4 welcome-stage clients and an admin. Sign-in details are in ${CREDENTIALS_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
