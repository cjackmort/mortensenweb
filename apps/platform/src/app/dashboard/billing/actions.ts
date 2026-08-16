"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import {
  declarePaid,
  markPaymentInitiated,
} from "@/db/repositories/client/billing";

/**
 * Client billing actions.
 *
 * Two deliberately separate steps, because they assert different things:
 *
 *   `openedVenmo`  — the client tapped through to their payment app. Intent.
 *   `declarePaid`  — the client says the money has been sent. A claim.
 *
 * Collapsing them into one button would mean anyone who tapped "Pay" and then
 * changed their mind would stop receiving reminders for an invoice they never
 * paid. Keeping them apart costs one extra tap and keeps the reminder ladder
 * honest.
 */

export type BillingActionResult =
  | { ok: true; declared: boolean }
  | { ok: false; message: string };

async function tenant() {
  const user = await currentUser();
  if (!user?.organizationId) return null;
  return {
    ctx: tenantContextFrom(user, user.organizationId),
    db: await getDb(),
  };
}

export async function openedVenmoAction(
  _previous: BillingActionResult | null,
  formData: FormData,
): Promise<BillingActionResult> {
  const scope = await tenant();
  if (!scope) return { ok: false, message: "Please sign in again." };

  await markPaymentInitiated(
    scope.db,
    scope.ctx,
    String(formData.get("requestPublicId") ?? ""),
  );

  revalidatePath("/dashboard/billing");
  return { ok: true, declared: false };
}

export async function declarePaidAction(
  _previous: BillingActionResult | null,
  formData: FormData,
): Promise<BillingActionResult> {
  const scope = await tenant();
  if (!scope) return { ok: false, message: "Please sign in again." };

  const result = await declarePaid(
    scope.db,
    scope.ctx,
    String(formData.get("requestPublicId") ?? ""),
  );

  if (!result.ok) {
    return {
      ok: false,
      message:
        "We couldn't record that — this invoice may already be settled. Refresh the page, and get in touch if it still looks wrong.",
    };
  }

  revalidatePath("/dashboard/billing");
  return { ok: true, declared: true };
}
