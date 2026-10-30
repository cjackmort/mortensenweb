import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  clients,
  organizations,
  paymentRequests,
  servicePlans,
  subscriptions,
} from "@/db/schema";
import { newPublicId } from "@/lib/ids";
import { currentPeriod } from "@/lib/billing/period";
import { generatePaymentReference } from "@/lib/payments/venmo";
import { assertMutable, type TenantContext } from "../context";

/**
 * The request/reuse half of buying one more change. Nothing here takes money:
 * the invoice row it produces is paid through Stripe (`startCardPaymentAction`)
 * or the Venmo hand-off, and only a confirmed payment records it as received.
 */

interface Resolved {
  clientId: string;
  businessName: string;
  subscriptionId: string | null;
}

async function resolveClient(
  db: Database,
  ctx: TenantContext,
): Promise<Resolved | null> {
  const rows = await db
    .select({
      clientId: clients.id,
      businessName: organizations.name,
      subscriptionId: subscriptions.id,
    })
    .from(clients)
    .innerJoin(organizations, eq(organizations.id, clients.organizationId))
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  return rows[0] ?? null;
}

/** Reference codes are unique; a collision retries rather than failing. */
async function insertPaymentRequest(
  db: Database,
  input: {
    clientId: string;
    subscriptionId: string | null;
    amountCents: number;
    note: string;
    purpose: "subscription" | "extra_change" | "other";
    coversPeriodStart?: string;
    coversPeriodEnd?: string;
  },
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const rows = await db
        .insert(paymentRequests)
        .values({
          publicId: newPublicId(),
          clientId: input.clientId,
          subscriptionId: input.subscriptionId,
          reference: generatePaymentReference(),
          amountCents: input.amountCents,
          status: "open",
          // Raised expecting the Venmo hand-off. Not a commitment — a client
          // can still pay by card — but it's what `confirmPaymentReceived`
          // defaults `method` to on the ledger row if nothing more specific is
          // passed at confirmation time.
          method: "venmo",
          provider: null,
          note: input.note,
          // These three were previously accepted by this function's own type
          // signature and then silently dropped here — every caller believed
          // it was tagging purpose/period and wasn't. The consequence was
          // invisible until something actually read `purpose` back: an
          // extra-change purchase would insert as a plain "subscription" row,
          // which `getBillingOverview` would surface as the amount due (wrong
          // label) and which the allowance-increment logic downstream would
          // never recognise as an extra-change purchase at all (silently
          // never crediting the allowance, even once confirmed).
          purpose: input.purpose,
          coversPeriodStart: input.coversPeriodStart ?? null,
          coversPeriodEnd: input.coversPeriodEnd ?? null,
        })
        .returning({
          id: paymentRequests.id,
          publicId: paymentRequests.publicId,
          reference: paymentRequests.reference,
        });
      return rows[0]!;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/reference/i.test(message)) throw error;
    }
  }
  throw new Error("Could not allocate a unique payment reference.");
}

export type ExtraChangeRequestOutcome =
  | {
      ok: true;
      publicId: string;
      reference: string;
      amountCents: number;
      businessName: string;
    }
  | {
      ok: false;
      reason: "no_client" | "not_offered";
      message: string;
    };

/**
 * The invoice for one additional change this month — created if it doesn't
 * already exist, reused if it does.
 *
 * Provider-agnostic on purpose: this only produces the payment request row,
 * not a checkout link. Stripe mints a card link from it separately; Venmo
 * builds its hand-off URL from the amount and reference directly, the same way
 * it does for the main "amount due" flow. The request/reuse logic never has to
 * know which rails happen to be configured.
 *
 * Reusing an existing open request matters: the reference is what a Venmo note
 * gets matched against, and a client who taps "buy another" twice in one month
 * should get the same invoice both times, not two.
 */
export async function getOrCreateExtraChangeRequest(
  db: Database,
  ctx: TenantContext,
): Promise<ExtraChangeRequestOutcome> {
  assertMutable(ctx);

  const resolved = await resolveClient(db, ctx);
  if (!resolved) {
    return { ok: false, reason: "no_client", message: "No client record found." };
  }

  const rows = await db
    .select({ overagePerChangeCents: servicePlans.overagePerChangeCents })
    .from(clients)
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptions.clientId, clients.id),
        eq(subscriptions.status, "active"),
      ),
    )
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
    .where(eq(clients.organizationId, ctx.organizationId))
    .limit(1);

  const overagePerChangeCents = rows[0]?.overagePerChangeCents ?? null;

  const period = currentPeriod();

  const existing = await db
    .select({
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
    })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.clientId, resolved.clientId),
        eq(paymentRequests.purpose, "extra_change"),
        eq(paymentRequests.coversPeriodStart, period.start),
        inArray(paymentRequests.status, [
          "open",
          "overdue",
          "awaiting_confirmation",
        ]),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return {
      ok: true,
      publicId: existing[0].publicId,
      reference: existing[0].reference,
      amountCents: existing[0].amountCents,
      businessName: resolved.businessName,
    };
  }

  // A null price means the plan does not sell extra changes. Refusing is
  // right: inventing a price would be worse than telling them to upgrade.
  if (!overagePerChangeCents) {
    return {
      ok: false,
      reason: "not_offered",
      message:
        "Your plan doesn't offer extra changes — moving to a bigger plan is the way to get more.",
    };
  }

  const created = await insertPaymentRequest(db, {
    clientId: resolved.clientId,
    subscriptionId: resolved.subscriptionId,
    amountCents: overagePerChangeCents,
    purpose: "extra_change",
    coversPeriodStart: period.start,
    coversPeriodEnd: period.end,
    note: "One additional change this month",
  });

  return {
    ok: true,
    publicId: created.publicId,
    reference: created.reference,
    amountCents: overagePerChangeCents,
    businessName: resolved.businessName,
  };
}
