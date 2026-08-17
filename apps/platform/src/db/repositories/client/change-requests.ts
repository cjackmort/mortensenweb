import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  changeRequests,
  requestEvents,
  sites,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
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
    })
    .from(changeRequests)
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

  let siteId: string | null = null;
  if (input.sitePublicId) {
    // The site must belong to the same tenant; otherwise a client could
    // attach a request to another client's site.
    const siteRows = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.publicId, input.sitePublicId),
          eq(sites.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    const site = siteRows[0];
    if (!site) throw new NotFoundError();
    siteId = site.id;
  }

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
