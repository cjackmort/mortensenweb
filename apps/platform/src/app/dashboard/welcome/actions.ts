"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { beginWelcomeCheckout } from "@/db/repositories/client/onboarding-checkout";

/**
 * Sending a new client to Stripe with what they chose on the welcome page.
 *
 * The form posts a plan key and add-on keys; the repository decides every
 * amount (`onboarding-checkout.ts`). Nothing is charged here — the URL that
 * comes back is Stripe's page, where the card is entered and the payment
 * authorised, and only the webhook records money.
 */

export type WelcomeCheckoutResult = { ok: true; url: string } | { ok: false; message: string };

/** A key is short and plain; anything else is not one of ours. */
const key = z.string().trim().max(40).regex(/^[a-z0-9-]*$/);

const choiceSchema = z.object({
  planKey: key,
  addOns: z.array(key.min(1)).max(20),
});

export async function startWelcomeCheckoutAction(
  _previous: WelcomeCheckoutResult | null,
  formData: FormData,
): Promise<WelcomeCheckoutResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return { ok: false, message: "Your account is not linked to an organization yet." };
  }

  const parsed = choiceSchema.safeParse({
    planKey: formData.get("planKey") ?? "",
    addOns: formData.getAll("addOns"),
  });
  if (!parsed.success) {
    return { ok: false, message: "That choice could not be read. Please reload the page and choose again." };
  }
  const planKey = parsed.data.planKey && parsed.data.planKey !== "none" ? parsed.data.planKey : null;

  const base = (process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (!base) {
    // Without an absolute base URL Stripe has nowhere to send the client back.
    return { ok: false, message: "Billing is not fully configured. Please get in touch." };
  }

  // Cancelling on Stripe's page comes back to this page with the same boxes
  // ticked, rather than making them choose again.
  const back = new URLSearchParams();
  if (planKey) back.set("plan", planKey);
  if (parsed.data.addOns.length > 0) back.set("addons", parsed.data.addOns.join(","));

  const db = await getDb();
  const outcome = await beginWelcomeCheckout(db, tenantContextFrom(user, user.organizationId), {
    planKey,
    addOns: parsed.data.addOns,
    // `?paid=1` only changes wording on Get started. The webhook settles the
    // payment; arriving at this URL proves nothing, since anyone can type it.
    successUrl: `${base}/dashboard/get-started?paid=1`,
    cancelUrl: `${base}/dashboard/welcome${back.size > 0 ? `?${back}` : ""}`,
  });

  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard/get-started");

  return outcome.ok ? { ok: true, url: outcome.url } : { ok: false, message: outcome.message };
}
