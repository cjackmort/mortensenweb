"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { beginCheckout } from "@/db/repositories/client/checkout";

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
