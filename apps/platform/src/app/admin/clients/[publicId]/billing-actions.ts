"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { getClientDetail } from "@/db/repositories/admin/clients";
import {
  confirmPaymentReceived,
  raisePaymentRequest,
  type PaymentMethod,
} from "@/db/repositories/admin/billing";

/**
 * Billing actions for one client.
 *
 * These revalidate, unlike the credential actions — nothing here returns a
 * one-time secret, so refreshing the page after a change is purely helpful.
 *
 * Both re-derive the admin context from the session. A server action is a
 * public POST endpoint; the page's role check protects the page, not this.
 */

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type BillingResult = { ok: true; message: string } | { ok: false; message: string };

/** Dollars as typed by a human, to whole cents. Rejects anything else. */
function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number.parseFloat(cleaned) * 100);
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}

export async function raiseRequestAction(
  _previous: BillingResult | null,
  formData: FormData,
): Promise<BillingResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const amountCents = parseAmountToCents(String(formData.get("amount") ?? ""));
  const dueOn = String(formData.get("dueOn") ?? "").trim();
  const note = String(formData.get("note") ?? "");

  if (amountCents === null) {
    return {
      ok: false,
      message: "Enter an amount in dollars, like 99 or 99.50.",
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    return { ok: false, message: "Pick a due date." };
  }

  let detail;
  try {
    detail = await getClientDetail(ctx, db, clientPublicId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { ok: false, message: "That client no longer exists." };
    }
    throw error;
  }

  const created = await raisePaymentRequest(ctx, db, {
    organizationId: detail.organization.id,
    amountCents,
    dueOn,
    note,
  });

  revalidatePath(`/admin/clients/${clientPublicId}`);
  // This action is also used from the payments page's monthly billing list.
  revalidatePath("/admin/payments");
  return {
    ok: true,
    message: `Raised ${created.reference}. The client can now see and pay it.`,
  };
}

export async function confirmReceivedAction(
  _previous: BillingResult | null,
  formData: FormData,
): Promise<BillingResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const requestPublicId = String(formData.get("requestPublicId") ?? "");
  const method = String(formData.get("method") ?? "venmo") as PaymentMethod;
  const receivedOn =
    String(formData.get("receivedOn") ?? "").trim() ||
    new Date().toISOString().slice(0, 10);

  const result = await confirmPaymentReceived(ctx, db, requestPublicId, {
    method,
    receivedOn,
  });

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "not_found"
          ? "That invoice no longer exists."
          : "That invoice can't be confirmed — it may be cancelled or written off.",
    };
  }

  revalidatePath(`/admin/clients/${clientPublicId}`);

  // Saying so matters: an operator who clicks twice should be told the second
  // click did nothing, not left wondering whether they double-charged.
  return {
    ok: true,
    message: result.alreadyConfirmed
      ? "Already confirmed — nothing was recorded twice."
      : "Payment recorded. Any paused work is resumed.",
  };
}
