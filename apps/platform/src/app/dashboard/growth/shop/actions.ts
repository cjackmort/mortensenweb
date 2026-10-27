"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { saveShopSettings, startStripeConnect, type ShopResult } from "@/db/repositories/client/shop-settings";

/**
 * Shop settings mutations. Each re-derives the tenant from the session — a
 * server action is a public POST endpoint — and each re-checks the feature,
 * because the page not showing a form to a client without it is no defence
 * against a request made by hand.
 */

type Refusal = { ok: false; message: string };

const NOT_SIGNED_IN: Refusal = { ok: false, message: "Please sign in again." };
const NOT_IN_PLAN: Refusal = { ok: false, message: "Your plan does not include the shop. See Growth to add it." };

async function session() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) return "locked" as const;
  return { ctx, db };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/**
 * "Connect Stripe": creates the account the first time, then sends the
 * client to Stripe's hosted onboarding. The redirect is outside the try so
 * Next's own redirect signal is not mistaken for a failure.
 */
export async function connectStripeAction(_previous: ShopResult | null, _form: FormData): Promise<ShopResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;

  const started = await startStripeConnect(s.db, s.ctx);
  if (!started.ok) return started;
  redirect(started.url);
}

export async function saveShopSettingsAction(_previous: ShopResult | null, form: FormData): Promise<ShopResult> {
  const s = await session();
  if (!s) return NOT_SIGNED_IN;
  if (s === "locked") return NOT_IN_PLAN;

  const result = await saveShopSettings(s.db, s.ctx, {
    fulfilment: text(form, "fulfilment"),
    shipping: text(form, "shipping"),
    taxEnabled: form.get("taxEnabled") === "on",
    refundPolicy: text(form, "refundPolicy"),
    shippingPolicy: text(form, "shippingPolicy"),
  });
  if (result.ok) revalidatePath("/dashboard/growth/shop", "layout");
  return result;
}
