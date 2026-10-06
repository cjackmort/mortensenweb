import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, subscriptions } from "@/db/schema";
import { businessDate } from "@/lib/billing/period";

/**
 * End the plan an operator assigned by hand, once Stripe is billing for it.
 *
 * A client paid by Venmo or cash has a `subscriptions` row with no provider:
 * it is how they have a plan at all. Enrolling them in Stripe adds a second,
 * Stripe-owned row, and leaving the first one active gives them two plans —
 * every lookup that takes the client's active subscription with `limit(1)`
 * then picks one at random, and the monthly billing list offers to invoice by
 * hand somebody Stripe is already charging.
 *
 * Only called once the Stripe subscription is active. A checkout whose first
 * payment failed leaves the client on the plan they had, still billed the way
 * they were. Square subscriptions are left alone: a Square row stands for a
 * live mandate on another processor, which has to be cancelled there.
 */
export async function retireHandBilledPlans(
  db: Database,
  input: {
    clientId: string;
    organizationId: string;
    stripeSubscriptionId: string;
  },
): Promise<void> {
  const today = businessDate(new Date());

  const retired = await db
    .update(subscriptions)
    .set({
      status: "cancelled",
      // Never before it started; the table refuses an end before a start, and
      // a refusal here would fail the webhook on every retry.
      endedOn: sql`GREATEST(${subscriptions.startedOn}, ${today}::date)`,
    })
    .where(
      and(
        eq(subscriptions.clientId, input.clientId),
        eq(subscriptions.status, "active"),
        isNull(subscriptions.provider),
      ),
    )
    .returning({ publicId: subscriptions.publicId });

  if (retired.length === 0) return;

  await db.insert(auditLog).values({
    organizationId: input.organizationId,
    action: "subscription.superseded",
    entityType: "subscription",
    entityId: input.stripeSubscriptionId,
    metadata: {
      source: "stripe_webhook",
      retired: retired.map((r) => r.publicId),
    },
  });
}
