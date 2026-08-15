import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  clients,
  organizations,
  prospects,
  sites,
  subscriptions,
} from "@/db/schema";
import type { AdminContext } from "../context";
import { NotFoundError } from "../context";

/**
 * Admin-only queries.
 *
 * These are unscoped by design and therefore live in a separate directory from
 * the client repositories. Every function requires an `AdminContext`, which
 * `adminContextFrom` only issues to an active admin session.
 *
 * Nothing in `src/app/(client)` may import from this directory. That rule is
 * enforced by review and by the fact that a client route has no way to obtain
 * an `AdminContext`.
 */

export async function listClients(_ctx: AdminContext, db: Database) {
  return db
    .select({
      clientPublicId: clients.publicId,
      organizationPublicId: organizations.publicId,
      name: organizations.name,
      primaryContactName: clients.primaryContactName,
      primaryContactEmail: clients.primaryContactEmail,
      industry: clients.industry,
      isDemo: clients.isDemo,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .innerJoin(organizations, eq(clients.organizationId, organizations.id))
    .where(isNull(clients.archivedAt))
    .orderBy(organizations.name);
}

export async function getClientDetail(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
) {
  const rows = await db
    .select({
      client: clients,
      organization: organizations,
    })
    .from(clients)
    .innerJoin(organizations, eq(clients.organizationId, organizations.id))
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError();

  const [clientSites, subscription, openRequests] = await Promise.all([
    db
      .select()
      .from(sites)
      .where(eq(sites.organizationId, row.organization.id)),
    db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.clientId, row.client.id),
          eq(subscriptions.status, "active"),
        ),
      )
      .limit(1),
    db
      .select({
        publicId: changeRequests.publicId,
        title: changeRequests.title,
        status: changeRequests.status,
        priority: changeRequests.priority,
      })
      .from(changeRequests)
      .where(eq(changeRequests.organizationId, row.organization.id))
      .orderBy(desc(changeRequests.createdAt))
      .limit(20),
  ]);

  return {
    client: row.client,
    organization: row.organization,
    sites: clientSites,
    subscription: subscription[0] ?? null,
    requests: openRequests,
  };
}

/**
 * Potential clients. Admin-only: there is deliberately no client-facing
 * repository anywhere in the codebase that reads the `prospects` table.
 */
export async function listProspects(_ctx: AdminContext, db: Database) {
  return db
    .select({
      publicId: prospects.publicId,
      businessName: prospects.businessName,
      sourceWebsiteUrl: prospects.sourceWebsiteUrl,
      industry: prospects.industry,
      status: prospects.status,
      isDemo: prospects.isDemo,
      updatedAt: prospects.updatedAt,
    })
    .from(prospects)
    .where(isNull(prospects.archivedAt))
    .orderBy(desc(prospects.updatedAt));
}

/** Every change request across all tenants, for the admin queue. */
export async function listAllChangeRequests(
  _ctx: AdminContext,
  db: Database,
  options: { limit?: number } = {},
) {
  return db
    .select({
      publicId: changeRequests.publicId,
      title: changeRequests.title,
      status: changeRequests.status,
      priority: changeRequests.priority,
      organizationName: organizations.name,
      createdAt: changeRequests.createdAt,
    })
    .from(changeRequests)
    .innerJoin(
      organizations,
      eq(changeRequests.organizationId, organizations.id),
    )
    .orderBy(desc(changeRequests.createdAt))
    .limit(options.limit ?? 100);
}
