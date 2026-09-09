import { and, desc, eq, getTableName, inArray, sql, type AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "@/db/client";
import { agentJobs, changeRequests, requestEvents, sites } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { BLOCKING_STATUSES } from "@/lib/requests/status";
import { cancelChangeRequest, type CancelOutcome } from "./cancel";
import { dispatchChangeRequest, type DispatchOutcome } from "./agent-jobs";
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

/**
 * A `"table"."column"` reference that survives a single-table select.
 *
 * Drizzle qualifies column names only when the statement has a join; without
 * one it emits bare `"id"` and `"request_id"`, which silently rewrites a
 * correlated subquery into a self-comparison. Both names are read off the
 * schema rather than written out, so renaming a column moves this with it
 * instead of leaving a string that compiles and matches nothing.
 */
function qualified(table: PgTable, column: AnyColumn) {
  return sql.raw(`"${getTableName(table)}"."${column.name}"`);
}

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

/**
 * Send the agency's own request to the agent.
 *
 * This exists because there was no way to do it. `listAllChangeRequests`
 * filters the internal client out of the operator queue on purpose — the
 * MortensenWeb tab is its own queue — and that tab offered submit and cancel
 * and nothing else. So a request raised on the agency's own site could be
 * created and could be called off, but could never be started: the only path
 * that would move it was `AGENT_AUTO_DISPATCH`, which is off by default and is
 * the unattended path rather than the deliberate one.
 *
 * The scoping check is the same as `cancelInternalChangeRequest`'s and matters
 * for the same reason: this is reached from a tab that is only ever about one
 * organization, so a request id belonging to a client must not be actionable
 * through it. An admin can dispatch that request from the operator queue, where
 * the client it belongs to is on screen.
 */
export async function dispatchInternalChangeRequest(
  ctx: AdminContext,
  db: Database,
  organizationId: string,
  requestPublicId: string,
): Promise<DispatchOutcome> {
  const [request] = await db
    .select({ organizationId: changeRequests.organizationId })
    .from(changeRequests)
    .where(eq(changeRequests.publicId, requestPublicId))
    .limit(1);

  if (!request || request.organizationId !== organizationId) {
    return {
      ok: false,
      reason: "not_found",
      message: "We couldn't find that request.",
    };
  }

  return dispatchChangeRequest(ctx, db, { requestPublicId });
}

/**
 * The agency's own requests, with what the agent is doing about them.
 *
 * `getClientDetail` returns requests without any job information, which left
 * the tab showing a progress bar and no way to tell whether the agent had ever
 * been handed the work. "It says submitted" and "it says submitted and nothing
 * has been sent" look identical, and the second is the one that needs someone.
 *
 * Latest job only, matching `listAllChangeRequests`: a re-dispatched request
 * should show its current attempt, not its first.
 */
export async function listInternalChangeRequests(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
  options: { limit?: number } = {},
) {
  return db
    .select({
      publicId: changeRequests.publicId,
      title: changeRequests.title,
      status: changeRequests.status,
      priority: changeRequests.priority,
      createdAt: changeRequests.createdAt,
      // Table-qualified by hand, and that is load-bearing.
      //
      // Drizzle only qualifies column names when the statement has a join. On
      // a single-table select it renders `${agentJobs.requestId}` as bare
      // `"request_id"` and `${changeRequests.id}` as bare `"id"`, so this
      // correlated subquery silently becomes
      // `where agent_jobs.request_id = agent_jobs.id` — a comparison that is
      // never true. It does not error. Every row simply comes back null, which
      // on screen is indistinguishable from "no agent has touched this", which
      // is the one thing this column exists to tell you.
      //
      // `listAllChangeRequests` writes the same subquery and is correct only
      // because it happens to join two tables. Do not copy that form here.
      agentDispatchedAt: sql<Date | null>`(
        select ${agentJobs.dispatchedAt} from ${agentJobs}
        where ${qualified(agentJobs, agentJobs.requestId)} = ${qualified(changeRequests, changeRequests.id)}
        order by ${agentJobs.createdAt} desc limit 1)`,
      agentFinishedAt: sql<Date | null>`(
        select coalesce(${agentJobs.finishedAt}, ${agentJobs.previewVerifiedAt}) from ${agentJobs}
        where ${qualified(agentJobs, agentJobs.requestId)} = ${qualified(changeRequests, changeRequests.id)}
        order by ${agentJobs.createdAt} desc limit 1)`,
      agentPrUrl: sql<string | null>`(
        select ${agentJobs.prUrl} from ${agentJobs}
        where ${qualified(agentJobs, agentJobs.requestId)} = ${qualified(changeRequests, changeRequests.id)}
        order by ${agentJobs.createdAt} desc limit 1)`,
    })
    .from(changeRequests)
    .where(eq(changeRequests.organizationId, organizationId))
    .orderBy(desc(changeRequests.createdAt))
    .limit(options.limit ?? 20);
}
