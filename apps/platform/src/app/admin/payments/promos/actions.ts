"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { createPromoCode, deactivatePromoCode } from "@/db/repositories/admin/build-promos";

/**
 * Making and switching off website promo codes. A server action is a public
 * POST endpoint, so each re-derives the admin context from the session.
 */

export type PromoCodeResult = { ok: boolean; message: string };

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

/** A date input's `YYYY-MM-DD`, as the end of that day in the business's day. */
function endOfDay(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T23:59:59-07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function createPromoCodeAction(
  _previous: PromoCodeResult | null,
  form: FormData,
): Promise<PromoCodeResult> {
  const ctx = await requireAdmin();
  const kind = form.get("kind") === "percent" ? "percent" : "amount";
  const rawValue = String(form.get("value") ?? "").trim().replace(/[$,%\s]/g, "");
  const number = Number(rawValue);
  if (!rawValue || !Number.isFinite(number)) return { ok: false, message: "Enter how much comes off." };
  const value = kind === "amount" ? Math.round(number * 100) : Math.round(number);
  const expires = String(form.get("expiresOn") ?? "");
  const cap = String(form.get("maxRedemptions") ?? "").trim();

  const result = await createPromoCode(ctx, await getDb(), {
    code: String(form.get("code") ?? "").trim(),
    kind,
    value,
    expiresAt: expires ? endOfDay(expires) : null,
    maxRedemptions: cap ? Number.parseInt(cap, 10) : null,
  });
  if (!result.ok) return result;

  revalidatePath("/admin/payments/promos");
  return { ok: true, message: `${result.code} is live: ${result.terms}.` };
}

export async function deactivatePromoCodeAction(
  _previous: PromoCodeResult | null,
  form: FormData,
): Promise<PromoCodeResult> {
  const ctx = await requireAdmin();
  const result = await deactivatePromoCode(ctx, await getDb(), String(form.get("id") ?? ""));
  if (result.ok) revalidatePath("/admin/payments/promos");
  return result;
}
