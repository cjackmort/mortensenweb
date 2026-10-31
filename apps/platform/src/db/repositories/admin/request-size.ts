import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, changeRequests } from "@/db/schema";
import type { AdminContext } from "../context";

/**
 * An operator correcting the size a client gave a request (decision D7).
 *
 * The client picks small or big from examples, and is sometimes wrong in
 * either direction. The size decides what a client whose site is not live may
 * ask for, and whether the agent is told to hand a bigger change back — so a
 * correction is recorded with who made it and what it was before.
 *
 * Only the label. A free small change already taken stays taken, and nothing
 * here refuses or dispatches anything: what to do with a request that turned
 * out bigger than its owner may ask for is the operator's call.
 */

export type SetSizeResult = { ok: true; changed: boolean } | { ok: false; reason: "not_found" };

export async function setRequestSize(
  ctx: AdminContext,
  db: Database,
  requestPublicId: string,
  size: "small" | "big",
): Promise<SetSizeResult> {
  const [request] = await db
    .select({ id: changeRequests.id, size: changeRequests.size, organizationId: changeRequests.organizationId })
    .from(changeRequests)
    .where(eq(changeRequests.publicId, requestPublicId))
    .limit(1);
  if (!request) return { ok: false, reason: "not_found" };
  if (request.size === size) return { ok: true, changed: false };

  await db.update(changeRequests).set({ size, updatedAt: new Date() }).where(eq(changeRequests.id, request.id));
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: request.organizationId,
    action: "request.size_changed",
    entityType: "change_request",
    entityId: requestPublicId,
    metadata: { from: request.size, to: size },
  });
  return { ok: true, changed: true };
}
