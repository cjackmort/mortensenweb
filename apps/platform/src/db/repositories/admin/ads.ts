import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { adCampaigns, auditLog } from "@/db/schema";

/**
 * The operator's side of paid ads.
 *
 * Unscoped by tenant, so it lives with the admin repositories and is reached
 * only through an `AdminContext` — or, as below, from inside
 * `confirmPaymentReceived`, which already holds one.
 */

/**
 * Money for a campaign has arrived: it moves to the operator's review queue.
 *
 * Called from `confirmPaymentReceived`, the one place a payment request is
 * ever marked paid, so a campaign settled by the Stripe webhook and one an
 * operator confirmed by hand both arrive here. Conditional on the campaign
 * still waiting for that payment: one the client took back to a draft has a
 * cancelled request, which `confirmPaymentReceived` refuses before this runs.
 */
export async function markAdCampaignPaid(
  db: Database,
  paymentRequestId: string,
  { at = new Date(), actorUserId }: { at?: Date; actorUserId?: string } = {},
): Promise<{ publicId: string } | null> {
  const [moved] = await db
    .update(adCampaigns)
    .set({ status: "pending_review", paidAt: at, updatedAt: at })
    .where(and(eq(adCampaigns.paymentRequestId, paymentRequestId), eq(adCampaigns.status, "awaiting_payment")))
    .returning({ publicId: adCampaigns.publicId, organizationId: adCampaigns.organizationId });

  if (!moved) return null;

  await db.insert(auditLog).values({
    actorUserId: actorUserId ?? null,
    organizationId: moved.organizationId,
    action: "ads.campaign_paid",
    entityType: "ad_campaign",
    entityId: moved.publicId,
    metadata: {},
  });

  return { publicId: moved.publicId };
}
