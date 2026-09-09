import type { Database } from "@/db/client";
import { clients, organizationMemberships, organizations, users } from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { tenantContextFrom, type TenantContext } from "@/db/repositories/context";

/**
 * A tenant, ready to act.
 *
 * Two of these in a suite is what makes a cross-tenant test meaningful: the
 * assertion is not "the query filtered" but "Globex's session cannot see
 * Acme's row", and that needs a real second organization rather than a
 * different id passed to the same one.
 */
export interface SeededTenant {
  organizationId: string;
  userId: string;
  clientId: string;
  ctx: TenantContext;
}

export async function seedTenant(
  db: Database,
  name: string,
  options: { mediaQuotaBytes?: number } = {},
): Promise<SeededTenant> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${newPublicId().slice(0, 6).toLowerCase()}`;

  const orgRows = await db
    .insert(organizations)
    .values({ publicId: newPublicId(), name, slug, kind: "client" })
    .returning({ id: organizations.id });
  const organizationId = orgRows[0]!.id;

  const userRows = await db
    .insert(users)
    .values({
      publicId: newPublicId(),
      email: `${slug}@example.test`,
      role: "client",
      status: "active",
      passwordHash: null,
    })
    .returning({ id: users.id });
  const userId = userRows[0]!.id;

  await db
    .insert(organizationMemberships)
    .values({ organizationId, userId, role: "owner" });

  const clientRows = await db
    .insert(clients)
    .values({
      publicId: newPublicId(),
      organizationId,
      onboardingStatus: "active",
      mediaQuotaBytes: options.mediaQuotaBytes ?? null,
    })
    .returning({ id: clients.id });

  const ctx = tenantContextFrom(
    {
      userId,
      organizationId,
      role: "client",
      status: "active",
      sessionEpoch: 0,
    },
    organizationId,
  );

  return { organizationId, userId, clientId: clientRows[0]!.id, ctx };
}
