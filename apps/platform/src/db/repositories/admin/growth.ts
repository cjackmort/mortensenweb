import { and, eq, isNull } from "drizzle-orm";
import { GROWTH_FEATURES, type GrowthFeatureKey } from "@mortensenweb/plans";
import type { Database } from "@/db/client";
import { auditLog, clientAddOns, clients, servicePlans, subscriptions } from "@/db/schema";
import { growthAccess, type FeatureAccess } from "@/lib/growth/access";
import { NotFoundError, type AdminContext } from "../context";

/**
 * Growth access from the operator's side: what a client has and why, and the
 * hand-granted add-ons only an operator can give or take away.
 *
 * Add-ons bought by card are not touched here. They are lines on the client's
 * Stripe subscription and Stripe is their record; ending one from the portal
 * while Stripe kept billing for it would be the worst of both.
 */

export interface ClientGrowthView {
  access: FeatureAccess[];
  addOns: Array<{ featureKey: string; source: string; startedAt: Date }>;
}

async function clientRow(db: Database, clientPublicId: string) {
  const [row] = await db
    .select({ id: clients.id, organizationId: clients.organizationId, compPlanId: clients.compPlanId })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

export async function getClientGrowth(
  _ctx: AdminContext,
  db: Database,
  clientPublicId: string,
): Promise<ClientGrowthView> {
  const client = await clientRow(db, clientPublicId);

  const [plan] = await db
    .select({ key: servicePlans.key })
    .from(subscriptions)
    .innerJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(and(eq(subscriptions.clientId, client.id), eq(subscriptions.status, "active")))
    .limit(1);

  const addOns = await db
    .select({ featureKey: clientAddOns.featureKey, source: clientAddOns.source, startedAt: clientAddOns.startedAt })
    .from(clientAddOns)
    .where(and(eq(clientAddOns.clientId, client.id), isNull(clientAddOns.endedAt)));

  return {
    access: growthAccess({
      planKey: plan?.key ?? null,
      comped: client.compPlanId !== null,
      addOns: addOns.map((a) => a.featureKey as GrowthFeatureKey),
    }),
    addOns,
  };
}

export type GrantResult = { ok: true; message: string } | { ok: false; message: string };

export async function grantAddOn(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  featureKey: string,
): Promise<GrantResult> {
  const feature = GROWTH_FEATURES.find((f) => f.key === featureKey);
  if (!feature) return { ok: false, message: "Unknown feature." };
  const client = await clientRow(db, clientPublicId);

  const inserted = await db
    .insert(clientAddOns)
    .values({ clientId: client.id, featureKey: feature.key, source: "operator" })
    .onConflictDoNothing()
    .returning({ id: clientAddOns.id });
  if (inserted.length === 0) return { ok: false, message: `They already have ${feature.name} as an add-on.` };

  await db.insert(auditLog).values({
    action: "growth.add_on_granted",
    entityType: "client",
    entityId: client.id,
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    metadata: { feature: feature.key },
  });
  return { ok: true, message: `${feature.name} granted.` };
}

export async function revokeAddOn(
  ctx: AdminContext,
  db: Database,
  clientPublicId: string,
  featureKey: string,
): Promise<GrantResult> {
  const client = await clientRow(db, clientPublicId);
  const now = new Date();
  const ended = await db
    .update(clientAddOns)
    .set({ endedAt: now, updatedAt: now })
    .where(
      and(
        eq(clientAddOns.clientId, client.id),
        eq(clientAddOns.featureKey, featureKey),
        eq(clientAddOns.source, "operator"),
        isNull(clientAddOns.endedAt),
      ),
    )
    .returning({ id: clientAddOns.id });
  if (ended.length === 0) {
    return { ok: false, message: "No hand-granted add-on to remove. One bought by card is removed in Stripe or by the client." };
  }

  await db.insert(auditLog).values({
    action: "growth.add_on_revoked",
    entityType: "client",
    entityId: client.id,
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    metadata: { feature: featureKey },
  });
  const name = GROWTH_FEATURES.find((f) => f.key === featureKey)?.name ?? featureKey;
  return { ok: true, message: `${name} removed.` };
}
