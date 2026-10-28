import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { sites } from "@/db/schema";
import {
  checklistsFor,
  writeListingStep,
  type MarkListingStepInput,
  type MarkResult,
  type SiteChecklist,
} from "@/lib/listings/checklist";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * Get listed, from the client's side: one checklist per site of theirs, and
 * the tick they can make on it themselves.
 *
 * Tenant-scoped like every client repository: the sites come from
 * `ctx.organizationId`, and a site public id from another tenant is a 404
 * before any write.
 */

async function tenantSites(db: Database, ctx: TenantContext) {
  return db
    .select({ id: sites.id, publicId: sites.publicId, name: sites.name, organizationId: sites.organizationId })
    .from(sites)
    .where(and(eq(sites.organizationId, ctx.organizationId), isNull(sites.archivedAt)))
    .orderBy(asc(sites.createdAt));
}

export async function listListingChecklists(db: Database, ctx: TenantContext): Promise<SiteChecklist[]> {
  return checklistsFor(db, await tenantSites(db, ctx));
}

/** True while any of the tenant's sites has fewer than half its steps done. The dashboard reminder. */
export async function needsListingReminder(db: Database, ctx: TenantContext): Promise<boolean> {
  const checklists = await listListingChecklists(db, ctx);
  return checklists.some((c) => c.progress.needsReminder);
}

export async function markListingStep(
  db: Database,
  ctx: TenantContext,
  sitePublicId: string,
  input: MarkListingStepInput,
): Promise<MarkResult> {
  assertMutable(ctx);
  const site = (await tenantSites(db, ctx)).find((s) => s.publicId === sitePublicId);
  if (!site) throw new NotFoundError();
  return writeListingStep(db, site, ctx.userId, input);
}
