import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  servicePlans,
  agentJobs,
  auditLog,
  changeRequests,
  clients,
  requestEvents,
  organizationMemberships,
  organizations,
  prospects,
  sites,
  subscriptions,
  users,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
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
      organizationId: organizations.id,
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
    // The agency's own site rides the same `clients` row so it can use the
    // same pipeline, but it is not a commercial client — every client-facing
    // list excludes it here, once, rather than in each caller.
    .where(and(isNull(clients.archivedAt), eq(clients.isInternal, false)))
    .orderBy(organizations.name);
}

/** The agency's own internal client row — the one `listClients` excludes. */
export async function getInternalClient(_ctx: AdminContext, db: Database) {
  const [row] = await db
    .select({
      clientPublicId: clients.publicId,
      organizationId: organizations.id,
      organizationPublicId: organizations.publicId,
      name: organizations.name,
    })
    .from(clients)
    .innerJoin(organizations, eq(clients.organizationId, organizations.id))
    .where(and(isNull(clients.archivedAt), eq(clients.isInternal, true)))
    .limit(1);
  return row ?? null;
}

/**
 * The client list with each one's first site attached — name and status only,
 * not analytics. Cards and tiles that only need "what stage is this site at"
 * render from this without paying for a Umami round trip per client.
 *
 * A client with more than one site shows the oldest — the same one
 * `getClientDetail` treats as primary elsewhere on admin surfaces.
 */
export async function listClientsWithPrimarySite(_ctx: AdminContext, db: Database) {
  const rows = await listClients(_ctx, db);
  if (rows.length === 0) return [];

  const siteRows = await db
    .select({
      organizationId: sites.organizationId,
      name: sites.name,
      status: sites.status,
      primaryDomain: sites.primaryDomain,
      productionUrl: sites.productionUrl,
      netlifySiteName: sites.netlifySiteName,
      createdAt: sites.createdAt,
    })
    .from(sites)
    .where(
      inArray(
        sites.organizationId,
        rows.map((r) => r.organizationId),
      ),
    )
    .orderBy(sites.createdAt);

  const siteByOrgId = new Map<string, (typeof siteRows)[number]>();
  for (const s of siteRows) {
    if (!siteByOrgId.has(s.organizationId)) siteByOrgId.set(s.organizationId, s);
  }

  return rows.map((r) => ({
    ...r,
    site: siteByOrgId.get(r.organizationId) ?? null,
  }));
}

/**
 * Turn a business name into a URL slug: "Scott Mortensen Fine Arts" becomes
 * `scott-mortensen-fine-arts`. The schema enforces lowercase via a check
 * constraint, so this must not return mixed case.
 */
export function slugForOrganization(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "client"
  );
}

export interface NewClientInput {
  businessName: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  phone?: string;
  industry?: string;
}

/**
 * Create the organization and client rows for a new client.
 *
 * Deliberately separate from `activateClient`. Creating the record is
 * bookkeeping and is safe to get wrong — it can be edited. Activation issues a
 * real credential and grants access, and the plan requires that to be a
 * distinct, deliberate act rather than a side effect of typing a name into a
 * form. A client created here cannot sign in until someone activates them.
 *
 * Slug collisions are resolved with a numeric suffix rather than failing, so
 * two clients with similar names do not produce an error the operator has to
 * work around by inventing a different business name.
 */
export async function createClient(
  ctx: AdminContext,
  db: Database,
  input: NewClientInput,
) {
  const name = input.businessName.trim();
  if (name.length < 2) {
    throw new Error("A business name is required.");
  }

  const base = slugForOrganization(name);
  let slug = base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const taken = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (taken.length === 0) break;
    slug = `${base}-${suffix}`;
  }

  const orgRows = await db
    .insert(organizations)
    .values({
      publicId: newPublicId(),
      name,
      slug,
      kind: "client",
      timezone: process.env.BUSINESS_TIMEZONE ?? "America/Denver",
    })
    .returning({ id: organizations.id, publicId: organizations.publicId });

  const organization = orgRows[0]!;

  const clientRows = await db
    .insert(clients)
    .values({
      publicId: newPublicId(),
      organizationId: organization.id,
      primaryContactName: input.primaryContactName?.trim() || null,
      primaryContactEmail:
        input.primaryContactEmail?.trim().toLowerCase() || null,
      phone: input.phone?.trim() || null,
      industry: input.industry?.trim() || null,
      // Not activated: no credential exists yet, and that is the point.
      onboardingStatus: "new",
    })
    .returning({ publicId: clients.publicId });

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: organization.id,
    action: "client.created",
    entityType: "client",
    entityId: clientRows[0]!.publicId,
    metadata: { name, slug },
  });

  return { clientPublicId: clientRows[0]!.publicId, slug };
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
        createdAt: changeRequests.createdAt,
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
 * The portal accounts belonging to one organization.
 *
 * This is what tells the activation UI whether to offer "activate" or
 * "reissue": `activateClient` refuses an email that already has an account, so
 * offering the wrong action produces an error the operator cannot act on.
 *
 * Deliberately returns no password material of any kind. `passwordHash` is not
 * selected — not because rendering it would be likely, but because a column
 * that never enters the query cannot leak into a server-component payload by
 * accident later.
 */
export async function listOrganizationUsers(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
) {
  return db
    .select({
      publicId: users.publicId,
      email: users.email,
      username: users.username,
      name: users.name,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      tempPasswordExpiresAt: users.tempPasswordExpiresAt,
      lastLoginAt: users.lastLoginAt,
      activatedAt: users.activatedAt,
      invitedAt: users.invitedAt,
    })
    .from(users)
    .innerJoin(
      organizationMemberships,
      eq(organizationMemberships.userId, users.id),
    )
    .where(eq(organizationMemberships.organizationId, organizationId))
    .orderBy(users.createdAt);
}

/** Resolve an internal user id from its public id, scoped to one organization. */
export async function findOrganizationUserId(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
  userPublicId: string,
): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      organizationMemberships,
      eq(organizationMemberships.userId, users.id),
    )
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(users.publicId, userPublicId),
      ),
    )
    .limit(1);

  // Scoping the lookup by organization means a public id from another client
  // reads as "does not exist" rather than reissuing someone else's credential.
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row.id;
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
      // How the automation is doing on this one, in numbers the operator can
      // scan: when the run started, when it produced a pull request or gave
      // up, and the pull request itself. Latest job only (see the subquery),
      // so a re-dispatched request shows its current attempt.
      agentDispatchedAt: sql<Date | null>`(
        select ${agentJobs.dispatchedAt} from ${agentJobs}
        where ${agentJobs.requestId} = ${changeRequests.id}
        order by ${agentJobs.createdAt} desc limit 1)`,
      agentFinishedAt: sql<Date | null>`(
        select coalesce(${agentJobs.finishedAt}, ${agentJobs.previewVerifiedAt}) from ${agentJobs}
        where ${agentJobs.requestId} = ${changeRequests.id}
        order by ${agentJobs.createdAt} desc limit 1)`,
      agentPrUrl: sql<string | null>`(
        select ${agentJobs.prUrl} from ${agentJobs}
        where ${agentJobs.requestId} = ${changeRequests.id}
        order by ${agentJobs.createdAt} desc limit 1)`,
      // The client's latest note, if they added one after sending — the
      // thing most likely to change what the operator does next.
      latestNote: sql<string | null>`(
        select ${requestEvents.body} from ${requestEvents}
        where ${requestEvents.requestId} = ${changeRequests.id}
          and ${requestEvents.kind} = 'client_note'
        order by ${requestEvents.createdAt} desc limit 1)`,
    })
    .from(changeRequests)
    .innerJoin(
      organizations,
      eq(changeRequests.organizationId, organizations.id),
    )
    // The MortensenWeb tab is a separate queue on purpose — mixing the
    // operator's own site work into the client queue is exactly what that
    // tab exists to avoid, so this join+filter keeps it out here too.
    .innerJoin(clients, eq(clients.organizationId, organizations.id))
    .where(eq(clients.isInternal, false))
    .orderBy(desc(changeRequests.createdAt))
    .limit(options.limit ?? 100);
}

/**
 * The comp override as an operator needs to see it.
 *
 * Returns the paid plan alongside the granted one, because the question when
 * withdrawing a comp is "what would they drop to?" — and answering it from the
 * effective plan alone is impossible.
 */
export async function getClientComp(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<{
  compPlanKey: string | null;
  compNote: string | null;
  paidPlanName: string | null;
} | null> {
  void ctx;

  const compPlan = alias(servicePlans, "comp_plan_admin");

  const rows = await db
    .select({
      compPlanKey: compPlan.key,
      compNote: clients.compNote,
      paidPlanName: servicePlans.name,
    })
    .from(clients)
    .leftJoin(compPlan, eq(compPlan.id, clients.compPlanId))
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);

  return rows[0] ?? null;
}
