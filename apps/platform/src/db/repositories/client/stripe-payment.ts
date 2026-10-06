import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { paymentRequests } from "@/db/schema";
import { requireStripe, stripeConfigured } from "@/lib/payments/stripe";
import { assertMutable, type TenantContext } from "../context";
import { ensureCustomer, resolveClient } from "./stripe-checkout";

/**
 * Paying one invoice by card, through Stripe Checkout.
 *
 * The one-off counterpart to `stripe-checkout.ts`, which sells subscriptions.
 * It covers every invoice that is not a subscription renewal: one an operator
 * raised, a client's first month, and one extra change.
 *
 * ## What the browser decides
 *
 * Which invoice — nothing else. The form posts a payment request's public id;
 * the amount, currency, customer and tenant all come from the database. The
 * invoice is looked up *within the session's client*, so a public id copied
 * from somebody else's page finds nothing, and the answer is the same
 * `not_found` an invoice that never existed gets.
 *
 * ## One checkout per invoice
 *
 * The session id is kept on the invoice and re-read from Stripe before a new
 * one is made. An open session is handed back, so a double click or a second
 * tab lands on the same checkout; a completed one means money is on its way
 * and a second payment is refused until the webhook settles the first. Only an
 * expired session is replaced.
 *
 * Nothing here marks anything paid. That happens when the webhook sees a
 * session whose payment Stripe reports as `paid` — see `stripe-one-off.ts`.
 */

export type StripePaymentOutcome =
  | { ok: true; url: string; reused: boolean }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "no_client"
        | "not_found"
        | "not_payable"
        | "processing"
        | "stripe_failed";
      message: string;
    };

export interface BeginStripePaymentInput {
  requestPublicId: string;
  /** Where Stripe returns the client. Built server-side by the caller. */
  successUrl: string;
  cancelUrl: string;
}

const PAYABLE = new Set(["open", "overdue"]);

type PayableRequest = {
  id: string;
  publicId: string;
  reference: string;
  amountCents: number;
  currency: string;
  status: string;
  purpose: "subscription" | "extra_change" | "other";
  note: string | null;
  provider: string | null;
  providerReference: string | null;
};

/** What the client sees on Stripe's page and their receipt. */
function lineItemName(request: PayableRequest): string {
  const label =
    request.purpose === "extra_change"
      ? "One additional change"
      : (request.note ?? "Website services");
  return `${label} (ref ${request.reference})`;
}

/**
 * The invoice's existing session, if it still decides anything.
 *
 * Returns the open session to reuse, `"processing"` for a completed one, or
 * null when there is none or it has expired and a new one is wanted.
 */
async function existingSession(
  request: PayableRequest,
): Promise<Stripe.Checkout.Session | "processing" | null> {
  if (request.provider !== "stripe" || !request.providerReference) return null;

  const session = await requireStripe().checkout.sessions.retrieve(
    request.providerReference,
  );

  if (session.status === "complete") return "processing";
  if (session.status === "open" && session.url) return session;
  return null;
}

export async function beginStripePayment(
  db: Database,
  ctx: TenantContext,
  input: BeginStripePaymentInput,
): Promise<StripePaymentOutcome> {
  assertMutable(ctx);

  if (!stripeConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Card payments are not set up yet. Please get in touch.",
    };
  }

  const client = await resolveClient(db, ctx);
  if (!client) {
    return {
      ok: false,
      reason: "no_client",
      message: "Your account is not linked to a client record.",
    };
  }

  const rows = await db
    .select({
      id: paymentRequests.id,
      publicId: paymentRequests.publicId,
      reference: paymentRequests.reference,
      amountCents: paymentRequests.amountCents,
      currency: paymentRequests.currency,
      status: paymentRequests.status,
      purpose: paymentRequests.purpose,
      note: paymentRequests.note,
      provider: paymentRequests.provider,
      providerReference: paymentRequests.providerReference,
    })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.publicId, input.requestPublicId),
        // The tenant boundary. Without it, any public id would be payable.
        eq(paymentRequests.clientId, client.clientId),
      ),
    )
    .limit(1);

  const request = rows[0];
  if (!request) {
    return { ok: false, reason: "not_found", message: "That invoice was not found." };
  }

  if (!PAYABLE.has(request.status) || request.amountCents <= 0) {
    return {
      ok: false,
      reason: "not_payable",
      message:
        request.status === "paid"
          ? "This invoice is already paid."
          : "This invoice can't be paid online. Please get in touch.",
    };
  }

  try {
    const existing = await existingSession(request);
    if (existing === "processing") {
      return {
        ok: false,
        reason: "processing",
        message:
          "Your payment for this is already going through. It can take a minute to show here.",
      };
    }
    if (existing) return { ok: true, url: existing.url!, reused: true };

    const customerId = await ensureCustomer(db, client);
    const metadata = {
      client_id: client.clientId,
      client_public_id: client.publicId,
      payment_request_id: request.publicId,
      purpose: request.purpose,
      reference: request.reference,
    };

    const session = await requireStripe().checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: request.amountCents,
              product_data: { name: lineItemName(request) },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: client.publicId,
        // On the session for the webhook; on the payment intent so a refund or
        // dispute seen in the dashboard still says which invoice it was.
        metadata,
        payment_intent_data: {
          metadata,
          description: lineItemName(request),
        },
      },
      {
        // Keyed on the session it replaces, so two clicks racing from the same
        // state collapse to one session, while replacing an expired session
        // gets a new key — the old one would hand the expired session back.
        idempotencyKey: `payment_request:${request.publicId}:after:${
          request.provider === "stripe" ? request.providerReference : "none"
        }`,
      },
    );

    if (!session.url) {
      return {
        ok: false,
        reason: "stripe_failed",
        message: "Stripe did not return a payment page. Please try again.",
      };
    }

    await db
      .update(paymentRequests)
      .set({
        provider: "stripe",
        method: "stripe",
        providerReference: session.id,
        checkoutUrl: session.url,
        updatedAt: new Date(),
      })
      .where(eq(paymentRequests.id, request.id));

    return { ok: true, url: session.url, reused: false };
  } catch (error) {
    console.error("[stripe:payment] failed", {
      clientId: client.clientId,
      requestPublicId: request.publicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return {
      ok: false,
      reason: "stripe_failed",
      message: "We couldn't start the payment just now. Please try again shortly.",
    };
  }
}
