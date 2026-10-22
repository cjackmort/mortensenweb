import type { Database } from "@/db/client";
import { auditLog } from "@/db/schema";
import { buildProductId } from "@/lib/payments/build";
import {
  createBuildPromo,
  deactivateBuildPromo,
  listBuildPromos,
  type BuildPromoRow,
  type CreateBuildPromoResult,
  type NewBuildPromo,
} from "@/lib/payments/build-promos";
import { stripeConfigured } from "@/lib/payments/stripe";
import type { AdminContext } from "../context";

/**
 * The operator's promo codes for the website price.
 *
 * Codes live in Stripe; this page makes them with the build-only restriction
 * already set, so changing codes around never needs the Stripe dashboard or
 * remembering which product to restrict them to. Every create and switch-off
 * is in the audit log, because "who gave out this code?" is asked later.
 */

const NOT_READY =
  "Stripe has no website build price yet. Run `npm run stripe:setup -- --apply`, then come back.";

export type PromoListing =
  | { ready: true; rows: BuildPromoRow[] }
  | { ready: false; message: string };

export async function listPromoCodes(_ctx: AdminContext): Promise<PromoListing> {
  if (!stripeConfigured()) return { ready: false, message: "Card payments aren't set up in this environment." };
  try {
    const product = await buildProductId();
    if (!product) return { ready: false, message: NOT_READY };
    return { ready: true, rows: await listBuildPromos({ buildProductId: product }) };
  } catch (error) {
    console.error("[admin:promos] could not list codes", { message: error instanceof Error ? error.message : "unknown" });
    return { ready: false, message: "Stripe could not be reached. Try again in a minute." };
  }
}

export async function createPromoCode(
  ctx: AdminContext,
  db: Database,
  input: NewBuildPromo,
): Promise<CreateBuildPromoResult> {
  if (!stripeConfigured()) return { ok: false, message: "Card payments aren't set up in this environment." };
  let product: string | null;
  try {
    product = await buildProductId();
  } catch {
    return { ok: false, message: "Stripe could not be reached. Nothing was created." };
  }
  if (!product) return { ok: false, message: NOT_READY };

  const result = await createBuildPromo(input, { buildProductId: product });
  if (result.ok) {
    await db.insert(auditLog).values({
      actorUserId: ctx.userId,
      action: "promo.created",
      entityType: "promotion_code",
      entityId: result.id,
      metadata: {
        code: result.code,
        terms: result.terms,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
      },
    });
  }
  return result;
}

export async function deactivatePromoCode(
  ctx: AdminContext,
  db: Database,
  promotionCodeId: string,
): Promise<{ ok: boolean; message: string }> {
  if (!/^promo_[A-Za-z0-9]+$/.test(promotionCodeId)) return { ok: false, message: "That isn't a promo code." };
  try {
    await deactivateBuildPromo(promotionCodeId);
  } catch (error) {
    console.error("[admin:promos] could not switch a code off", { message: error instanceof Error ? error.message : "unknown" });
    return { ok: false, message: "Stripe could not switch that code off. Try again in a minute." };
  }
  await db.insert(auditLog).values({
    actorUserId: ctx.userId,
    action: "promo.deactivated",
    entityType: "promotion_code",
    entityId: promotionCodeId,
    metadata: {},
  });
  return { ok: true, message: "Switched off. Nobody can use it from now on." };
}
