/**
 * Attaches the agency's own site to the pipeline it builds for everyone else.
 *
 * Real data, unlike seed.ts: the actual repository, the actual production
 * domain. `seed.ts` refuses to hold anything but demo rows on purpose, so
 * this is deliberately a separate script rather than an addition to it.
 *
 * The agency organization already exists — `db:seed` creates it so the admin
 * user has somewhere to belong to. This attaches a `clients` row to that same
 * organization (flagged `is_internal`, which every client-facing list and
 * every billing rollup filters out) rather than creating a second
 * organization named the same thing.
 *
 * Idempotent: safe to run again, does nothing on the second run.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import {
  clients,
  organizations,
  repositoryConnections,
  sites,
} from "../src/db/schema";
import { newPublicId } from "../src/lib/ids";

const REPO_OWNER = "cjackmort";
const REPO_NAME = "mortensenweb";
const PRODUCTION_DOMAIN = "portal.mortensenweb.com";

async function main() {
  const db = await getDb();

  const [agencyOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.kind, "agency"))
    .limit(1);

  if (!agencyOrg) {
    throw new Error(
      "No agency organization found — run `npm run db:seed` first.",
    );
  }

  const [existing] = await db
    .select()
    .from(clients)
    .where(eq(clients.organizationId, agencyOrg.id))
    .limit(1);

  if (existing) {
    console.log("Already linked — nothing to do.");
    console.log(`  Client public ID: ${existing.publicId}`);
    return;
  }

  const [client] = await db
    .insert(clients)
    .values({
      publicId: newPublicId(),
      organizationId: agencyOrg.id,
      onboardingStatus: "active",
      isInternal: true,
    })
    .returning();

  const [site] = await db
    .insert(sites)
    .values({
      publicId: newPublicId(),
      organizationId: agencyOrg.id,
      name: "Portal",
      primaryDomain: PRODUCTION_DOMAIN,
      status: "live",
    })
    .returning();

  // `allowlisted` stays at its schema default (false) — connecting the
  // repository is not the same decision as letting a webhook dispatch an
  // unattended agent against it. That switch is the operator's, made later
  // through the same RepositoryPanel every other client's page uses.
  await db.insert(repositoryConnections).values({
    publicId: newPublicId(),
    siteId: site!.id,
    owner: REPO_OWNER,
    name: REPO_NAME,
    defaultBranch: "main",
  });

  console.log("Linked the agency's own site.");
  console.log(`  Client public ID: ${client!.publicId}`);
  console.log(`  Repository: ${REPO_OWNER}/${REPO_NAME} (not allowlisted yet)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
