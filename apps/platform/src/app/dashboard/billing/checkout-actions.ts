"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { beginCheckout } from "@/db/repositories/client/checkout";
import { beginStripePayment } from "@/db/repositories/client/stripe-payment";
import { cardProvider } from "@/lib/payments/card-provider";

/**
 * Starting a card payment.
 *
 * Returns the Square URL rather than redirecting from the server. The
 * difference matters: a server redirect would leave the client with no record
 * of what happened if Square is slow or refuses, whereas returning it lets the
 * page say "we couldn't start this" and keep them where they are.
 *
 * Nothing here records a payment. The button sends someone to a checkout page;
 * money arriving is a separate fact, established by a verified webhook or an
 * operator confirming receipt.
 */

export type CheckoutResult =
  | { ok: true; url: string; reference: string }
  | { ok: false; message: string };

export async function startCheckoutAction(
  _previous: CheckoutResult | null,
  formData: FormData,
): Promise<CheckoutResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return {
      ok: false,
      message: "Your account is not linked to an organization yet.",
    };
  }

  const recurring = formData.get("recurring") === "true";

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const base = process.env.AUTH_URL ?? "";
  const outcome = await beginCheckout(db, ctx, {
    recurring,
    // Square returns them here afterwards. Back to billing, where the invoice
    // will still show as due until the webhook lands — which the page explains,
    // rather than showing a stale "unpaid" with no context.
    returnUrl: base ? `${base.replace(/\/$/, "")}/dashboard/billing?paid=1` : undefined,
  });

  revalidatePath("/dashboard/billing");

  if (!outcome.ok) return { ok: false, message: outcome.message };

  return { ok: true, url: outcome.url, reference: outcome.reference };
}

export type CardPaymentResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/**
 * Paying one specific invoice by card.
 *
 * Stripe pays exactly the invoice the button belongs to. The Square path is
 * kept for environments without Stripe, and pays the client's oldest open
 * invoice as it always has.
 *
 * The form posts the invoice's public id and nothing else; the amount and the
 * client come from the database and the session.
 */
export async function startCardPaymentAction(
  _previous: CardPaymentResult | null,
  formData: FormData,
): Promise<CardPaymentResult> {
  const provider = cardProvider();
  // The form posts no `recurring`, which the Square action reads as one-off.
  if (provider === "square") return startCheckoutAction(null, formData);
  if (!provider) {
    return { ok: false, message: "Card payments are not set up yet." };
  }

  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return {
      ok: false,
      message: "Your account is not linked to an organization yet.",
    };
  }

  const requestPublicId = String(formData.get("requestPublicId") ?? "");
  if (!requestPublicId) return { ok: false, message: "Nothing to pay." };

  const base = (process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (!base) {
    // Without an absolute base URL Stripe has nowhere to send the client back.
    return {
      ok: false,
      message: "Billing is not fully configured. Please get in touch.",
    };
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const outcome = await beginStripePayment(db, ctx, {
    requestPublicId,
    // `?payment=complete` only changes wording on the billing page. The
    // invoice is settled by the webhook, never by arriving at this URL.
    successUrl: `${base}/dashboard/billing?payment=complete`,
    cancelUrl: `${base}/dashboard/billing`,
  });

  revalidatePath("/dashboard/billing");

  if (!outcome.ok) return { ok: false, message: outcome.message };
  return { ok: true, url: outcome.url };
}
