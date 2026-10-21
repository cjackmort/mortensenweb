import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfiles, organizations } from "@/db/schema";
import { NotFoundError, tenantContextFrom, type TenantContext } from "@/db/repositories/context";
import { getCampaign, type CampaignDetail } from "@/db/repositories/client/ads";
import type { AuthenticatedUser } from "@/lib/auth/session";
import type { Database } from "@/db/client";

/**
 * What every campaign page needs. Takes the user each page has already read
 * with `currentUser()`, so the page itself stays the authentication boundary
 * (see `tests/route-auth.test.ts`) and this only resolves the tenant.
 */
export async function loadCampaignPage(
  user: AuthenticatedUser | null,
  publicId: string,
): Promise<{
  ctx: TenantContext;
  db: Database;
  campaign: CampaignDetail;
  businessName: string;
  readOnly: boolean;
}> {
  if (!user) redirect("/login");
  if (!user.organizationId) redirect("/dashboard");

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  let campaign: CampaignDetail;
  try {
    campaign = await getCampaign(db, ctx, publicId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [org] = await db
    .select({ name: organizations.name, details: businessProfiles.details })
    .from(organizations)
    .leftJoin(businessProfiles, eq(businessProfiles.organizationId, organizations.id))
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);

  return {
    ctx,
    db,
    campaign,
    businessName: org?.details?.businessName?.trim() || org?.name || "Your business",
    readOnly: ctx.impersonating,
  };
}
