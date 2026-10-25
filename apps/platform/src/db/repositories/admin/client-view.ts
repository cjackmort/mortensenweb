import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clients, impersonationSessions, organizations } from "@/db/schema";
import { isValidPublicId, newPublicId, normalisePublicId } from "@/lib/ids";
import type { AdminContext } from "../context";
import { getInternalClient } from "./clients";

/**
 * "Switch to MortensenWeb": the operator using the portal as the agency's own
 * client.
 *
 * Each switch is a row in `impersonation_sessions` — who, when, from where,
 * and when they switched back — and the browser holds only that row's public
 * id. The id is worthless on its own: a lookup also requires the admin who
 * started it, so a copied cookie does nothing without that admin's session.
 *
 * Only the internal client can be the target, and that is checked on every
 * lookup rather than only at the start. Moving the "MortensenWeb tab" to
 * another record, or archiving it, ends every open switch on the next request.
 * This is what keeps it from being an "act as any client" tool: the one
 * organization it reaches is the agency's own.
 */

/** A switch stops on its own after this long, whether or not anyone switched back. */
export const CLIENT_VIEW_MAX_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

export interface ClientView {
  sessionPublicId: string;
  organizationId: string;
  organizationName: string;
}

/** Open a switch to the internal client. Null when no record is marked as the agency's own. */
export async function startClientView(
  ctx: AdminContext,
  db: Database,
  context: { ipHash?: string | null } = {},
): Promise<ClientView | null> {
  const internal = await getInternalClient(ctx, db);
  if (!internal) return null;

  const sessionPublicId = newPublicId();
  await db.insert(impersonationSessions).values({
    publicId: sessionPublicId,
    adminUserId: ctx.userId,
    targetOrganizationId: internal.organizationId,
    reason: "Switched to MortensenWeb",
    ipHash: context.ipHash ?? null,
  });

  return {
    sessionPublicId,
    organizationId: internal.organizationId,
    organizationName: internal.name,
  };
}

/**
 * The switch this admin has open under `sessionPublicId`, or null when it was
 * ended, has run out, belongs to someone else, or no longer points at the
 * internal client.
 */
export async function findClientView(
  ctx: AdminContext,
  db: Database,
  sessionPublicId: string,
  now: Date = new Date(),
): Promise<ClientView | null> {
  if (!isValidPublicId(sessionPublicId)) return null;
  const startedAfter = new Date(now.getTime() - CLIENT_VIEW_MAX_HOURS * HOUR_MS);

  const [row] = await db
    .select({
      sessionPublicId: impersonationSessions.publicId,
      organizationId: organizations.id,
      organizationName: organizations.name,
    })
    .from(impersonationSessions)
    .innerJoin(organizations, eq(organizations.id, impersonationSessions.targetOrganizationId))
    .innerJoin(
      clients,
      and(
        eq(clients.organizationId, impersonationSessions.targetOrganizationId),
        eq(clients.isInternal, true),
        isNull(clients.archivedAt),
      ),
    )
    .where(
      and(
        eq(impersonationSessions.publicId, normalisePublicId(sessionPublicId)),
        eq(impersonationSessions.adminUserId, ctx.userId),
        isNull(impersonationSessions.endedAt),
        gt(impersonationSessions.startedAt, startedAfter),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Switch back. A no-op for a session that is already ended or not this admin's. */
export async function endClientView(
  ctx: AdminContext,
  db: Database,
  sessionPublicId: string,
): Promise<void> {
  if (!isValidPublicId(sessionPublicId)) return;
  await db
    .update(impersonationSessions)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(impersonationSessions.publicId, normalisePublicId(sessionPublicId)),
        eq(impersonationSessions.adminUserId, ctx.userId),
        isNull(impersonationSessions.endedAt),
      ),
    );
}
