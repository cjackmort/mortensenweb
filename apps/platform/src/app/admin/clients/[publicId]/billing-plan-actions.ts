"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { assignBillingPlan } from "@/db/repositories/admin/billing-plan";
import { beginCheckoutForClient } from "@/db/repositories/client/stripe-checkout";
import { parseBillingDay } from "@/lib/billing/billing-day";

/**
 * Choosing a client's plan and payment day, and handing out a payment link.
 *
 * Both check the admin role here and again through `adminContextFrom`; the
 * repository does the rest, including every Stripe call.
 */

export type PlanFormResult = { ok: boolean; message: string };

export async function assignPlanAction(
  _previous: PlanFormResult | null,
  formData: FormData,
): Promise<PlanFormResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can do that." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  const planKey = String(formData.get("planKey") ?? "").trim();
  const billingDay = parseBillingDay(formData.get("billingDay"));
  if (!clientPublicId) return { ok: false, message: "No client specified." };
  if (!planKey) return { ok: false, message: "Choose a plan." };
  if (billingDay === null) return { ok: false, message: "Choose a day from the 1st to the 28th." };

  const db = await getDb();
  const result = await assignBillingPlan(adminContextFrom(user), db, {
    clientPublicId,
    planKey,
    billingDay,
  });

  revalidatePath(`/admin/clients/${clientPublicId}`);
  return result;
}

export type PaymentLinkResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

export async function createPaymentLinkAction(
  _previous: PaymentLinkResult | null,
  formData: FormData,
): Promise<PaymentLinkResult> {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    return { ok: false, message: "Only an admin can do that." };
  }

  const clientPublicId = String(formData.get("clientPublicId") ?? "").trim();
  if (!clientPublicId) return { ok: false, message: "No client specified." };

  const base = (process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (!base) return { ok: false, message: "AUTH_URL isn't set, so Stripe has nowhere to send them back." };

  const db = await getDb();
  const outcome = await beginCheckoutForClient(adminContextFrom(user), db, clientPublicId, {
    successUrl: `${base}/dashboard/billing?checkout=complete`,
    cancelUrl: `${base}/dashboard/billing?checkout=cancelled`,
  });

  return outcome.ok ? { ok: true, url: outcome.url } : { ok: false, message: outcome.message };
}
