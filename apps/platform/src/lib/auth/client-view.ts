import type { Database } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { findClientView } from "@/db/repositories/admin/client-view";
import type { AuthenticatedUser } from "./session";

/**
 * The signed-in user as the portal should treat them, once a "Switch to
 * MortensenWeb" is taken into account.
 *
 * An admin with an open switch becomes a *client* of the internal
 * organization: `role: "client"` with that organization's id, exactly the shape
 * a client's own session has. So every client page, form and action works
 * unchanged — they all gate on that shape — and every admin page sends them to
 * the dashboard until they switch back.
 *
 * Writes are allowed, which is the difference from the read-only "view as
 * client" that `TenantContext.impersonating` describes. That one is for looking
 * at a paying client's account; this one is the agency's own, and the point is
 * to submit its forms the way a client would. The user id stays the admin's,
 * so anything written is attributed to the person who actually did it.
 *
 * Anything that does not resolve — a stale cookie, a switch that ran out, a
 * client account — leaves the user exactly as they were.
 */
export async function resolveClientView(
  db: Database,
  user: AuthenticatedUser,
  sessionPublicId: string | undefined,
): Promise<AuthenticatedUser> {
  if (user.role !== "admin" || !sessionPublicId) return user;

  const view = await findClientView(adminContextFrom(user), db, sessionPublicId);
  if (!view) return user;

  return {
    ...user,
    role: "client",
    organizationId: view.organizationId,
    viewingAs: {
      organizationName: view.organizationName,
      sessionPublicId: view.sessionPublicId,
    },
  };
}
