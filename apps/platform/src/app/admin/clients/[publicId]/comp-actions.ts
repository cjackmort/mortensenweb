"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { auditLog, clients, servicePlans } from "@/db/schema";
import { adminContextFrom } from "@/db/repositories/context";

/**
 * Setting or withdrawing a comped plan.
 *
 * Writes an audit row either way. A client receiving a paid product for
 * nothing is exactly the kind of thing that needs to be explicable months
 * later, and "who decided this, and when" is not recoverable from the column
 * alone.
 */

export type CompResult = { ok: boolean; message: string };

export async function setCompPlanAction(
  _previous: CompResult | null,
  formData: FormData,
): Promise<CompResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can do that." };
  }

  const ctx = adminContextFrom(user);
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  const planKey = String(formData.get("compPlanId") ?? "").trim();
  const note = String(formData.get("compNote") ?? "").trim();

  if (!clientPublicId) return { ok: false, message: "No client specified." };

  const clientRows = await db
    .select({
      id: clients.id,
      organizationId: clients.organizationId,
      currentCompPlanId: clients.compPlanId,
    })
    .from(clients)
    .where(eq(clients.publicId, clientPublicId))
    .limit(1);

  const client = clientRows[0];
  if (!client) return { ok: false, message: "No such client." };

  let planId: string | null = null;
  let planName: string | null = null;

  if (planKey) {
    const planRows = await db
      .select({ id: servicePlans.id, name: servicePlans.name })
      .from(servicePlans)
      .where(eq(servicePlans.key, planKey))
      .limit(1);

    const plan = planRows[0];
    if (!plan) return { ok: false, message: "No such plan." };
    planId = plan.id;
    planName = plan.name;
  }

  await db
    .update(clients)
    .set({
      compPlanId: planId,
      // Cleared alongside the plan. A note explaining a comp that no longer
      // exists is worse than none — it reads as though one is still in force.
      compNote: planId ? note || null : null,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, client.id));

  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    organizationId: client.organizationId,
    action: planId ? "client.comp_granted" : "client.comp_withdrawn",
    entityType: "client",
    entityId: clientPublicId,
    metadata: {
      plan: planName,
      note: planId ? note || null : null,
      previous: client.currentCompPlanId,
    },
  });

  revalidatePath(`/admin/clients/${clientPublicId}`);

  return {
    ok: true,
    message: planId
      ? `${planName} granted free of charge. Analytics and change requests are unlocked.`
      : "Override withdrawn. Access now follows what they have paid for.",
  };
}
