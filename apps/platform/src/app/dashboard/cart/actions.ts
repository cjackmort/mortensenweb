"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { beginCartCheckout, checkCartPromo, type CartPromoResult } from "@/db/repositories/client/cart";

/**
 * The cart's two calls: check a promo code, and go to Stripe.
 *
 * Both take the tenant from the session. The checkout form posts a plan key,
 * add-on keys and the code as typed — never a price, an amount or a customer
 * — and the repository re-checks all three against Stripe before anything is
 * created. Neither records a payment: only the verified webhook does.
 */

async function session() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  return { ctx: tenantContextFrom(user, user.organizationId), db: await getDb() };
}

export async function checkPromoAction(code: string): Promise<CartPromoResult> {
  const s = await session();
  if (!s) return { ok: false, message: "Please sign in again." };
  return checkCartPromo(s.db, s.ctx, String(code ?? "").slice(0, 64));
}

export type CartCheckoutResult = { ok: true; url: string } | { ok: false; message: string };

function portalBaseUrl(): string {
  return (process.env.AUTH_URL ?? "").replace(/\/$/, "");
}

export async function startCartCheckoutAction(
  _previous: CartCheckoutResult | null,
  form: FormData,
): Promise<CartCheckoutResult> {
  const s = await session();
  if (!s) return { ok: false, message: "Please sign in again." };

  const base = portalBaseUrl();
  if (!base) return { ok: false, message: "Billing is not fully configured. Please get in touch." };

  const outcome = await beginCartCheckout(s.db, s.ctx, {
    planKey: String(form.get("planKey") ?? "") || null,
    addOnKeys: form.getAll("addOn").map(String).slice(0, 20),
    promoCode: String(form.get("promoCode") ?? "").slice(0, 64),
    // `?checkout=complete` only changes wording on Billing; nothing about
    // access is decided by it, because anybody can type it.
    successUrl: `${base}/dashboard/billing?checkout=complete`,
    cancelUrl: `${base}/dashboard/cart?checkout=cancelled`,
  });

  revalidatePath("/dashboard/cart");
  return outcome.ok ? { ok: true, url: outcome.url } : { ok: false, message: outcome.message };
}
