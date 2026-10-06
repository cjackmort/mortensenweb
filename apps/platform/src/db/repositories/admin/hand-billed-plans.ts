import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLog, paymentRequests, subscriptions } from "@/db/schema";
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
 *
 * The hand-raised invoice for that same month goes with it — see
 * `supersedeHandInvoices`.
 */
export async function retireHandBilledPlans(
  db: Database,
  input: {
    clientId: string;
    organizationId: string;
    stripeSubscriptionId: string;
    /** When Stripe started billing, and what it charges each month. */
    stripeStartedAt: Date;
    stripeMonthlyCents: number;
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

  const superseded = await supersedeHandInvoices(db, input);

  if (retired.length === 0 && superseded.length === 0) return;

  await db.insert(auditLog).values({
    organizationId: input.organizationId,
    action: "subscription.superseded",
    entityType: "subscription",
    entityId: input.stripeSubscriptionId,
    metadata: {
      source: "stripe_webhook",
      retired: retired.map((r) => r.publicId),
      invoicesCancelled: superseded.map((r) => r.reference),
    },
  });
}

/**
 * Cancel the hand-raised invoice that Stripe's subscription now charges for.
 *
 * The usual way onto Stripe is: the operator raises this month's invoice, and
 * the client, offered both, sets up card payments instead of paying it. Left
 * alone, that invoice stays "open" beside a subscription that has already
 * collected the same month — the client is shown a bill they have paid, and
 * the reminder ladder chases them for it.
 *
 * Every condition below is a reason to leave an invoice for a person instead,
 * because cancelling one that was really owed writes off a debt silently:
 *
 *  - **Raised before Stripe started.** One raised afterwards was raised for a
 *    client already on Stripe, so it is for something else.
 *  - **Due on or after Stripe's start.** One due earlier is for a period
 *    Stripe never covered — an old debt, not this month's.
 *  - **For exactly the monthly price Stripe charges.** Anything else is not
 *    the same bill.
 *  - **Nobody has started paying it.** Not declared paid, not opened in
 *    Venmo, no card or Square checkout attached. Any of those may mean money
 *    is on its way for it, and cancelling would leave that money nowhere to
 *    land: the operator's confirm button only appears on unsettled invoices.
 *
 * Only `purpose = subscription`: an extra change is bought on its own.
 */
async function supersedeHandInvoices(
  db: Database,
  input: {
    clientId: string;
    stripeStartedAt: Date;
    stripeMonthlyCents: number;
  },
): Promise<{ reference: string }[]> {
  if (input.stripeMonthlyCents <= 0) return [];

  return db
    .update(paymentRequests)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(paymentRequests.clientId, input.clientId),
        eq(paymentRequests.purpose, "subscription"),
        inArray(paymentRequests.status, ["open", "overdue"]),
        eq(paymentRequests.amountCents, input.stripeMonthlyCents),
        lte(paymentRequests.createdAt, input.stripeStartedAt),
        isNotNull(paymentRequests.dueOn),
        gte(paymentRequests.dueOn, businessDate(input.stripeStartedAt)),
        isNull(paymentRequests.initiatedAt),
        isNull(paymentRequests.providerReference),
      ),
    )
    .returning({ reference: paymentRequests.reference });
}
