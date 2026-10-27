"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { NotFoundError, tenantContextFrom } from "@/db/repositories/context";
import { requireUsableGrowthFeature } from "@/db/repositories/client/growth";
import { markOrderShipped, restockOrder, type OrderResult } from "@/db/repositories/client/shop-orders";

/**
 * Order mutations: shipped, and restock. Each re-derives the tenant from the
 * session and looks the order up inside the caller's own organization only.
 */

const SIGN_IN_AGAIN: OrderResult = { ok: false, message: "Please sign in again." };
const NOT_IN_PLAN: OrderResult = { ok: false, message: "Your plan does not include the shop. See Growth to add it." };
const GONE: OrderResult = { ok: false, message: "That order no longer exists." };

async function context() {
  const user = await currentUser();
  if (!user?.organizationId || user.role !== "client") return null;
  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  if (!(await requireUsableGrowthFeature(db, ctx, "shop"))) return "locked" as const;
  return { ctx, db };
}

async function guarded(run: () => Promise<OrderResult>): Promise<OrderResult> {
  try {
    const result = await run();
    if (result.ok) {
      revalidatePath("/dashboard/growth/shop/orders");
      revalidatePath("/dashboard/growth/shop");
    }
    return result;
  } catch (error) {
    if (error instanceof NotFoundError) return GONE;
    throw error;
  }
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function markShippedAction(_previous: OrderResult | null, form: FormData): Promise<OrderResult> {
  const s = await context();
  if (!s) return SIGN_IN_AGAIN;
  if (s === "locked") return NOT_IN_PLAN;
  return guarded(() => markOrderShipped(s.db, s.ctx, text(form, "order")));
}

export async function restockAction(_previous: OrderResult | null, form: FormData): Promise<OrderResult> {
  const s = await context();
  if (!s) return SIGN_IN_AGAIN;
  if (s === "locked") return NOT_IN_PLAN;
  return guarded(() => restockOrder(s.db, s.ctx, text(form, "order")));
}
