import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  agentJobs,
  changeRequests,
  requestEvents,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { SETTLED_STATUSES } from "@/lib/requests/status";
import {
  assertMutable,
  NotFoundError,
  type TenantContext,
} from "../context";

/**
 * Client-facing change request access.
 *
 * Every function here takes a `TenantContext` and every query filters on
 * `ctx.organizationId`. There is no exported function that can read another
 * tenant's rows, and no parameter that can widen the scope.
 */

export async function listChangeRequests(
  db: Database,
  ctx: TenantContext,
  options: { limit?: number } = {},
) {
  return db
    .select({
      publicId: changeRequests.publicId,
      title: changeRequests.title,
      status: changeRequests.status,
      priority: changeRequests.priority,
      category: changeRequests.category,
      createdAt: changeRequests.createdAt,
      updatedAt: changeRequests.updatedAt,

      // The preview, so a request in the history says where to look rather
      // than only how far along it is. Only a verified one: an unfetched URL
      // is a link that may 404, and a client following a broken preview
      // concludes the work is broken rather than merely unfinished.
      previewUrl: sql<string | null>`case
        when ${agentJobs.previewVerifiedAt} is not null
        then ${agentJobs.previewUrl}
      end`,
      previewDecision: agentJobs.clientDecision,
    })
    .from(changeRequests)
    .leftJoin(agentJobs, eq(agentJobs.requestId, changeRequests.id))
    .where(eq(changeRequests.organizationId, ctx.organizationId))
    .orderBy(desc(changeRequests.createdAt))
    .limit(options.limit ?? 50);
}

/**
 * Fetch one request by public identifier.
 *
 * Returns null when the request does not exist *or* belongs to another tenant.
 * The caller renders both as 404.
 */
export async function findChangeRequest(
  db: Database,
  ctx: TenantContext,
  publicId: string,
) {
  const rows = await db
    .select()
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.publicId, publicId),
        // The tenant predicate. Without it this function would be a
        // cross-tenant read primitive.
        eq(changeRequests.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function getChangeRequestOrThrow(
  db: Database,
  ctx: TenantContext,
  publicId: string,
) {
  const found = await findChangeRequest(db, ctx, publicId);
  if (!found) throw new NotFoundError();
  return found;
}

/**
 * The client-visible timeline.
 *
 * `visibility` is hard-coded here rather than accepted as a parameter, so no
 * caller can request internal agent logs through this function.
 */
export async function listClientVisibleEvents(
  db: Database,
  ctx: TenantContext,
  requestPublicId: string,
) {
  const request = await getChangeRequestOrThrow(db, ctx, requestPublicId);

  return db
    .select({
      kind: requestEvents.kind,
      body: requestEvents.body,
      actorType: requestEvents.actorType,
      createdAt: requestEvents.createdAt,
    })
    .from(requestEvents)
    .where(
      and(
        eq(requestEvents.requestId, request.id),
        eq(requestEvents.visibility, "client_visible"),
      ),
    )
    .orderBy(requestEvents.createdAt);
}

/**
 * The open request on a site, if there is one.
 *
 * One change at a time, per site — and the reason is sequencing, not throttling.
 * Each agent branch is cut from the site's default branch when the job is
 * dispatched. Two changes open at once means the second branch was cut before
 * the first landed, so merging it can quietly undo the first: the client asked
 * for two things and got one, with nothing reporting a problem.
 *
 * Keyed off `SETTLED_STATUSES`, the same set the progress track calls settled,
 * so "still open" means one thing across the whole platform. Note that
 * `deployed` is *not* settled — the next change stays blocked until the deploy
 * has been confirmed live, which is exactly when the branch it will be cut from
 * is known to contain the last one.
 *
 * `siteId` null is its own bucket rather than a wildcard: requests not attached
 * to a site block each other, and do not block a site.
 */
export async function findOpenRequestForSite(
  db: Database,
  ctx: TenantContext,
  sitePublicId?: string,
) {
  const siteId = sitePublicId
    ? await resolveSiteId(db, ctx, sitePublicId)
    : null;

  const rows = await db
    .select({
      publicId: changeRequests.publicId,
      title: changeRequests.title,
      status: changeRequests.status,
    })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.organizationId, ctx.organizationId),
        siteId === null
          ? isNull(changeRequests.siteId)
          : eq(changeRequests.siteId, siteId),
        notInArray(changeRequests.status, [...SETTLED_STATUSES]),
      ),
    )
    .orderBy(desc(changeRequests.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Public site id to internal id, scoped to the tenant.
 *
 * Throws `NotFoundError` for a site belonging to someone else, so a client
 * cannot use another tenant's site id to probe for or attach to their requests.
 */
async function resolveSiteId(
  db: Database,
  ctx: TenantContext,
  sitePublicId: string,
): Promise<string> {
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.publicId, sitePublicId),
        eq(sites.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);

  const site = rows[0];
  if (!site) throw new NotFoundError();
  return site.id;
}

export interface NewChangeRequestInput {
  title: string;
  description?: string;
  category?: "content" | "design" | "bug" | "seo" | "feature" | "other";
  priority?: "low" | "normal" | "high" | "urgent";
  desiredTiming?: string;
  sitePublicId?: string;
  /**
   * The allowance period this request was counted against, claimed by the
   * caller before getting here. Recorded so the month's usage can be
   * reconciled against the requests that caused it.
   */
  allowanceId?: string;
  /** How this change is paid for, decided at submission. See the enum. */
  billing?: "included" | "overage" | "courtesy";
}

export async function createChangeRequest(
  db: Database,
  ctx: TenantContext,
  input: NewChangeRequestInput,
) {
  assertMutable(ctx);

  // The site must belong to the same tenant; otherwise a client could attach a
  // request to another client's site. `resolveSiteId` throws when it does not.
  const siteId = input.sitePublicId
    ? await resolveSiteId(db, ctx, input.sitePublicId)
    : null;

  const publicId = newPublicId();

  const inserted = await db
    .insert(changeRequests)
    .values({
      publicId,
      organizationId: ctx.organizationId,
      siteId,
      createdByUserId: ctx.userId,
      title: input.title.trim(),
      description: input.description ?? null,
      category: input.category ?? "other",
      priority: input.priority ?? "normal",
      desiredTiming: input.desiredTiming ?? null,
      status: "submitted",
      allowanceId: input.allowanceId ?? null,
      billing: input.billing ?? "included",
    })
    .returning();

  const created = inserted[0];
  if (!created) throw new Error("Insert returned no row.");

  await db.insert(requestEvents).values({
    requestId: created.id,
    actorType: "client",
    actorUserId: ctx.userId,
    kind: "submitted",
    body: "Request submitted.",
    visibility: "client_visible",
  });

  return created;
}

/** Sites belonging to this tenant. */
export async function listSites(db: Database, ctx: TenantContext) {
  return db
    .select({
      publicId: sites.publicId,
      name: sites.name,
      primaryDomain: sites.primaryDomain,
      status: sites.status,
    })
    .from(sites)
    .where(eq(sites.organizationId, ctx.organizationId))
    .orderBy(sites.name);
}
