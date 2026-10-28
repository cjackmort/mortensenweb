import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, sites } from "@/db/schema";
import {
  checklistsFor,
  writeListingStep,
  type MarkListingStepInput,
  type MarkResult,
  type SiteChecklist,
} from "@/lib/listings/checklist";
import { NotFoundError, type AdminContext } from "../context";

/**
 * Get listed, from the operator's side: the same checklist, ticked on the
 * client's behalf. Every mark is audited, because the client page attributes
 * it to "Mortensen Web" and the operator should be able to say when.
 */

export async function listOrganizationChecklists(
  _ctx: AdminContext,
  db: Database,
  organizationId: string,
): Promise<SiteChecklist[]> {
  const rows = await db
    .select({ id: sites.id, publicId: sites.publicId, name: sites.name })
    .from(sites)
    .where(eq(sites.organizationId, organizationId))
    .orderBy(asc(sites.createdAt));
  return checklistsFor(db, rows);
}

export async function markListingStepForClient(
  ctx: AdminContext,
  db: Database,
  organizationId: string,
  sitePublicId: string,
  input: MarkListingStepInput,
): Promise<MarkResult> {
  const [site] = await db
    .select({ id: sites.id, organizationId: sites.organizationId })
    .from(sites)
    .where(and(eq(sites.publicId, sitePublicId), eq(sites.organizationId, organizationId)))
    .limit(1);
  if (!site) throw new NotFoundError();

  const result = await writeListingStep(db, site, ctx.userId, input);
  if (result.ok) {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      organizationId,
      action: "listing_step.marked",
      entityType: "site",
      entityId: sitePublicId,
      metadata: { stepKey: input.stepKey, done: input.done ?? null, noteChanged: input.note !== undefined },
    });
  }
  return result;
}
