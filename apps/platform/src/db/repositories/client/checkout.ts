import { and, desc, eq, inArray } from "drizzle-orm";
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
import {
  createCheckoutLink,
  isSquareConfigured,
  SquareApiError,
} from "@/lib/payments/square";
import { assertMutable, NotFoundError, type TenantContext } from "../context";

/**
 * Sending a client to Square to pay.
 *
 * Two situations, one path:
 *
 *  - **An invoice already exists.** The operator raised it; the client is
 *    choosing card over Venmo. Reuse it, so the reference the operator is
 *    watching for is the reference that gets paid.
 *  - **No invoice exists.** This is the "unlock analytics" case — a client
 *    deciding to start paying before anyone has asked them to. One is raised
 *    for the plan price.
 *
 * The second is unusual: it is a client creating their own invoice. That is
 * correct here, because the alternative is a client who wants to pay having to
 * wait for someone to notice and raise one, which is a strange thing to make
 * somebody do.
 *
 * Nothing here marks anything paid. The checkout link is an *invitation*; only
 * a verified Square webhook or an operator confirming receipt records money as
 * arrived. That distinction is the same one `awaiting_confirmation` exists for.
 */

export type CheckoutOutcome =
  | { ok: true; url: string; reference: string; amountCents: number }
  | {
      ok: false;
      reason: "not_configured" | "no_client" | "no_plan" | "square_failed";
      message: string;
    };

interface Resolved {
  clientId: string;
  businessName: string;
  planName: string | null;
  monthlyPriceCents: number | null;
  subscriptionId: string | null;
  squarePlanVariationId: string | null;
}

async function resolveClient(
  db: Database,
  ctx: TenantContext,
): Promise<Resolved | null> {
  const rows = await db
    .select({
      clientId: clients.id,
      businessName: organizations.name,
      planName: servicePlans.name,
      squarePlanVariationId: servicePlans.squarePlanVariationId,
      monthlyPriceCents: subscriptions.monthlyPriceCents,
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
    .leftJoin(servicePlans, eq(servicePlans.id, subscriptions.planId))
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
          method: "square",
          provider: "square",
          note: input.note,
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

export interface CheckoutInput {
  /**
   * Enrol in recurring billing rather than taking a single payment. Requires
   * the plan to carry a Square subscription plan variation id.
   */
  recurring?: boolean;
  /** Where Square returns the client afterwards. */
  returnUrl?: string;
}

/**
 * Produce a Square checkout URL for this client's current amount due.
 *
 * Reusing an existing open invoice matters more than it looks: the reference is
 * what an operator reconciles against, and minting a second one for the same
 * month leaves two open invoices where only one is owed.
 */
export async function beginCheckout(
  db: Database,
  ctx: TenantContext,
  input: CheckoutInput = {},
): Promise<CheckoutOutcome> {
  assertMutable(ctx);

  if (!isSquareConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Card payments are not set up yet. Please get in touch and we'll sort it out.",
    };
  }

  const resolved = await resolveClient(db, ctx);
  if (!resolved) throw new NotFoundError();

  // The oldest unsettled invoice, matching what the billing page shows as due.
  const openRows = await db
    .select({
      id: paymentRequests.id,
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      checkoutUrl: paymentRequests.checkoutUrl,
    })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.clientId, resolved.clientId),
        inArray(paymentRequests.status, ["open", "overdue"]),
      ),
    )
    .orderBy(paymentRequests.dueOn, desc(paymentRequests.createdAt))
    .limit(1);

  let request = openRows[0];

  if (!request) {
    // Nothing owed and nothing raised — this is the unlock case.
    if (!resolved.monthlyPriceCents) {
      return {
        ok: false,
        reason: "no_plan",
        message:
          "There's no plan on your account yet, so there's nothing to set up. Please get in touch.",
      };
    }

    // Narrow race: two clicks landing together could both find nothing and both
    // insert. The consequence is a spare open invoice an operator can cancel —
    // not a double charge, because the Square idempotency key below is derived
    // from the reference, so each invoice yields exactly one payment link.
    const created = await insertPaymentRequest(db, {
      clientId: resolved.clientId,
      subscriptionId: resolved.subscriptionId,
      amountCents: resolved.monthlyPriceCents,
      purpose: "subscription",
      note: resolved.planName ? `${resolved.planName} — first month` : "Website services",
    });

    request = { ...created, amountCents: resolved.monthlyPriceCents, checkoutUrl: null };
  }

  // A link already minted for this invoice is reused rather than replaced.
  // Square payment links are durable objects; making a fresh one per page load
  // would leave a trail of live links and make it ambiguous which one was paid.
  if (request.checkoutUrl) {
    return {
      ok: true,
      url: request.checkoutUrl,
      reference: request.reference,
      amountCents: request.amountCents,
    };
  }

  const planVariationId = input.recurring
    ? (resolved.squarePlanVariationId ?? undefined)
    : undefined;

  let link;
  try {
    link = await createCheckoutLink({
      name: resolved.planName ?? "Website services",
      amountCents: request.amountCents,
      reference: request.reference,
      planVariationId,
      redirectUrl: input.returnUrl,
      // Derived from the reference, so a retry returns the original link
      // instead of creating a second one.
      idempotencyKey: `payment_request:${request.publicId}`,
    });
  } catch (error) {
    const detail =
      error instanceof SquareApiError ? ` (${error.status})` : "";
    console.error("[checkout] Square rejected the request", error);
    return {
      ok: false,
      reason: "square_failed",
      message: `We couldn't start the payment just now${detail}. Please try again shortly.`,
    };
  }

  await db
    .update(paymentRequests)
    .set({
      checkoutUrl: link.url,
      providerReference: link.id,
      provider: "square",
      method: "square",
      updatedAt: new Date(),
    })
    .where(eq(paymentRequests.id, request.id));

  return {
    ok: true,
    url: link.url,
    reference: request.reference,
    amountCents: request.amountCents,
  };
}

/**
 * Whether recurring billing can be offered at all.
 *
 * Requires a Square subscription plan variation recorded against the plan.
 * Without one the checkout would take a single payment while the button
 * promised a subscription, which is the kind of mismatch a client only notices
 * a month later when nothing was taken.
 */
export async function recurringAvailable(
  db: Database,
  ctx: TenantContext,
): Promise<boolean> {
  const resolved = await resolveClient(db, ctx);
  return Boolean(resolved?.squarePlanVariationId) && isSquareConfigured();
}

// ---------------------------------------------------------------------------
// Buying one more change
// ---------------------------------------------------------------------------

export type ExtraChangeOutcome =
  | { ok: true; url: string; amountCents: number }
  | {
      ok: false;
      reason: "not_configured" | "no_client" | "not_offered" | "square_failed";
      message: string;
    };

/**
 * Buy a single additional change for the current month.
 *
 * The prompt a client sees when their allowance runs out has, until now, been
 * an offer nothing could accept: it named a price and linked to a billing page
 * that could not take it. This is the other half.
 *
 * Capacity is bought, not a specific request. That is a deliberate choice over
 * attaching the payment to the change they were part-way through writing:
 * tying them together would mean holding a half-finished request in a paid-or-
 * not limbo, and a client who abandons the payment leaves a row nobody can
 * explain. Buying capacity keeps the two independent — the allowance goes up,
 * and they submit whenever they like.
 *
 * The allowance is **not** raised here. It moves when the money is confirmed,
 * in the webhook, for the same reason nothing else in this codebase treats
 * pressing a button as payment.
 */
export async function purchaseExtraChange(
  db: Database,
  ctx: TenantContext,
  input: { returnUrl?: string } = {},
): Promise<ExtraChangeOutcome> {
  assertMutable(ctx);

  if (!isSquareConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Card payments aren't set up yet. Get in touch and we'll sort this out.",
    };
  }

  const rows = await db
    .select({
      clientId: clients.id,
      subscriptionId: subscriptions.id,
      planName: servicePlans.name,
      overagePerChangeCents: servicePlans.overagePerChangeCents,
    })
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

  const row = rows[0];
  if (!row) return { ok: false, reason: "no_client", message: "No client record found." };

  // A null price means the plan does not sell extra changes. Refusing is right:
  // inventing a price would be worse than telling them to upgrade.
  if (!row.overagePerChangeCents) {
    return {
      ok: false,
      reason: "not_offered",
      message:
        "Your plan doesn't offer extra changes — moving to a bigger plan is the way to get more.",
    };
  }

  const period = currentPeriod();

  const request = await insertPaymentRequest(db, {
    clientId: row.clientId,
    subscriptionId: row.subscriptionId,
    amountCents: row.overagePerChangeCents,
    purpose: "extra_change",
    // The period is what ties the payment to the month whose allowance it
    // raises. Without it the webhook would have to guess, and guessing would
    // credit the wrong month for anyone paying near a boundary.
    coversPeriodStart: period.start,
    coversPeriodEnd: period.end,
    note: "One additional change this month",
  });

  let link;
  try {
    link = await createCheckoutLink({
      name: "One additional change",
      amountCents: row.overagePerChangeCents,
      reference: request.reference,
      redirectUrl: input.returnUrl,
      idempotencyKey: `payment_request:${request.publicId}`,
    });
  } catch (error) {
    console.error("[checkout] Square rejected the extra-change request", error);
    return {
      ok: false,
      reason: "square_failed",
      message: "We couldn't start the payment just now. Please try again shortly.",
    };
  }

  await db
    .update(paymentRequests)
    .set({
      checkoutUrl: link.url,
      providerReference: link.id,
      updatedAt: new Date(),
    })
    .where(eq(paymentRequests.id, request.id));

  return { ok: true, url: link.url, amountCents: row.overagePerChangeCents };
}
