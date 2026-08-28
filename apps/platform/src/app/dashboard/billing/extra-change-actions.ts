"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getOrCreateExtraChangeRequest } from "@/db/repositories/client/checkout";
import {
  buildVenmoPaymentUrl,
  configuredVenmoHandle,
  formatCurrency,
} from "@/lib/payments/venmo";
import { isSquareConfigured } from "@/lib/payments/square";

/**
 * Starting an extra-change purchase.
 *
 * Mirrors `startCheckoutAction`'s shape (return details, don't redirect from
 * the server) for the same reason: a failure should leave the client on this
 * page with an explanation, not on a broken one.
 *
 * Unlike the main checkout action, this one always succeeds in producing a
 * *request* even when Square isn't configured — `getOrCreateExtraChangeRequest`
 * doesn't touch Square at all. The card option only appears in the returned
 * result when Square happens to be configured; the invoice itself doesn't
 * care which rails exist.
 */

export type ExtraChangeStartResult =
  | {
      ok: true;
      requestPublicId: string;
      reference: string;
      amount: string;
      venmoUrl: string | null;
      cardAvailable: boolean;
    }
  | { ok: false; message: string };

export async function beginExtraChangeAction(
  _previous: ExtraChangeStartResult | null,
  _formData: FormData,
): Promise<ExtraChangeStartResult> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Please sign in again." };
  if (!user.organizationId) {
    return {
      ok: false,
      message: "Your account is not linked to an organization yet.",
    };
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();

  const outcome = await getOrCreateExtraChangeRequest(db, ctx);
  revalidatePath("/dashboard/billing");

  if (!outcome.ok) return { ok: false, message: outcome.message };

  const handle = configuredVenmoHandle();
  const venmoUrl = handle
    ? buildVenmoPaymentUrl({
        handle,
        amountCents: outcome.amountCents,
        reference: outcome.reference,
        businessName: outcome.businessName,
      })
    : null;

  return {
    ok: true,
    requestPublicId: outcome.publicId,
    reference: outcome.reference,
    amount: formatCurrency(outcome.amountCents),
    venmoUrl,
    cardAvailable: isSquareConfigured(),
  };
}
