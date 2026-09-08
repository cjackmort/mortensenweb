"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  beginStripeCheckout,
  createBillingPortalSession,
} from "@/db/repositories/client/stripe-checkout";

/**
 * Starting and managing a card subscription.
 *
 * Both actions take the tenant from the session and nothing else that decides
 * money or identity. The form posts a plan key; it does not post a price, an
 * amount, a customer id or an organization id, and if it did they would be
 * ignored — see `stripe-checkout.ts`.
 *
 * Neither action records a payment. Checkout is an invitation; only a verified
 * webhook carrying a settled invoice puts money in the ledger.
 */

function portalBaseUrl(): string {
  return (process.env.AUTH_URL ?? "").replace(/\/$/, "");
}

export type StripeCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

export async function startStripeSubscriptionAction(
  _previous: StripeCheckoutResult | null,
  formData: FormData,
): Promise<StripeCheckoutResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return {
      ok: false,
      message: "Your account is not linked to an organization yet.",
    };
  }

  const planKey = String(formData.get("planKey") ?? "");
  if (!planKey) return { ok: false, message: "Choose a plan first." };

  const base = portalBaseUrl();
  if (!base) {
    // Without an absolute base URL Stripe has nowhere to return the client,
    // and a relative one silently sends them to Stripe's own domain.
    return {
      ok: false,
      message: "Billing is not fully configured. Please get in touch.",
    };
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const outcome = await beginStripeCheckout(db, ctx, {
    planKey,
    // `?checkout=complete` makes the billing page show a "processing" notice
    // rather than a stale "not subscribed". It is a hint for wording only —
    // nothing about access is decided by this parameter, because anybody can
    // type it into the address bar.
    successUrl: `${base}/dashboard/billing?checkout=complete`,
    cancelUrl: `${base}/dashboard/billing?checkout=cancelled`,
  });

  revalidatePath("/dashboard/billing");

  if (!outcome.ok) return { ok: false, message: outcome.message };
  return { ok: true, url: outcome.url };
}

export type PortalResult = { ok: true; url: string } | { ok: false; message: string };

export async function openBillingPortalAction(): Promise<PortalResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return { ok: false, message: "Your account is not linked to an organization." };
  }

  const base = portalBaseUrl();
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  // The customer id comes from this tenant's own row inside the repository —
  // there is no input here that could open another client's billing.
  return createBillingPortalSession(
    db,
    ctx,
    `${base}/dashboard/billing`,
  );
}
