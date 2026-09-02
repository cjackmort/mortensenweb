import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { changeRequests, requestEvents, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { BLOCKING_STATUSES } from "@/lib/requests/status";
import { cancelChangeRequest, type CancelOutcome } from "./cancel";
import type { AdminContext } from "../context";

/**
 * Submitting a change request for the agency's own site, from the admin side.
 *
 * `client/change-requests.ts::createChangeRequest` does the same insert but
 * requires a `TenantContext` — a real client session. There is no client
 * session here by design (the operator is signed in as themselves, not
 * impersonating), so this is a parallel admin-safe path rather than a way to
 * construct a `TenantContext` for an organization nobody is authenticated
 * into. It mirrors the same one-open-request-per-site rule for the same
 * reason it exists on the client side: this goes through the identical
 * branch-per-request pipeline, and two open requests on one site can still
 * undo each other on merge.
 */

export type CreateInternalRequestResult =
  | { ok: true; publicId: string }
  | { ok: false; reason: "site_not_found" | "request_open"; message: string };

export interface NewInternalRequestInput {
  organizationId: string;
  sitePublicId: string;
  title: string;
  description?: string;
  category?: "content" | "design" | "bug" | "seo" | "feature" | "other";
  priority?: "low" | "normal" | "high" | "urgent";
}

export async function createInternalChangeRequest(
  ctx: AdminContext,
  db: Database,
  input: NewInternalRequestInput,
): Promise<CreateInternalRequestResult> {
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.publicId, input.sitePublicId))
    .limit(1);

  if (!site) {
    return { ok: false, reason: "site_not_found", message: "That site no longer exists." };
  }

  const [openRequest] = await db
    .select({ title: changeRequests.title })
    .from(changeRequests)
    .where(
      and(
        eq(changeRequests.organizationId, input.organizationId),
        eq(changeRequests.siteId, site.id),
        inArray(changeRequests.status, [...BLOCKING_STATUSES]),
      ),
    )
    .orderBy(desc(changeRequests.createdAt))
    .limit(1);

  if (openRequest) {
    return {
      ok: false,
      reason: "request_open",
      message: `"${openRequest.title}" is still open. One change moves through the pipeline at a time, same as any client.`,
    };
  }

  const [created] = await db
    .insert(changeRequests)
    .values({
      publicId: newPublicId(),
      organizationId: input.organizationId,
      siteId: site.id,
      createdByUserId: ctx.userId,
      title: input.title.trim(),
      description: input.description || null,
      category: input.category ?? "other",
      priority: input.priority ?? "normal",
      status: "submitted",
      // Nobody is billed for the agency's own site — there is no allowance
      // to count this against.
      billing: "courtesy",
    })
    .returning();

  if (!created) throw new Error("Insert returned no row.");

  await db.insert(requestEvents).values({
    requestId: created.id,
    actorType: "admin",
    actorUserId: ctx.userId,
    kind: "submitted",
    body: "Request submitted.",
    visibility: "client_visible",
  });

  return { ok: true, publicId: created.publicId };
}

/**
 * Calling one off, the same way a client can. Ownership is checked here —
 * `organizationId` is compared before `cancelChangeRequest` (which trusts its
 * `requestId` completely) ever runs — because unlike the client action, there
 * is no `TenantContext` upstream that already proved this request belongs to
 * this organization.
 */
export async function cancelInternalChangeRequest(
  ctx: AdminContext,
  db: Database,
  organizationId: string,
  requestPublicId: string,
): Promise<CancelOutcome> {
  const [request] = await db
    .select({ id: changeRequests.id, organizationId: changeRequests.organizationId })
    .from(changeRequests)
    .where(eq(changeRequests.publicId, requestPublicId))
    .limit(1);

  if (!request || request.organizationId !== organizationId) {
    return { ok: false, reason: "not_found", message: "We couldn't find that request." };
  }

  return cancelChangeRequest(db, {
    requestId: request.id,
    actorUserId: ctx.userId,
    actorType: "admin",
  });
}
