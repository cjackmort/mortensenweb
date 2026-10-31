"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { confirmPaymentReceived } from "@/db/repositories/admin/billing";
import {
  MANUAL_METHODS,
  markInvoiceNotPaid,
  recordManualPayment,
} from "@/db/repositories/admin/payment-outcomes";
import { methodLabel } from "@/lib/finance/ledger-csv";
import { parseAmountToCents } from "@/lib/finance/money";
import { formatCurrency } from "@/lib/payments/venmo";

/**
 * "They paid" and "they did not", from the payments page.
 *
 * Each re-derives the admin context: a server action is a public POST
 * endpoint, and the page's role check protects the page, not this. Input is
 * parsed with zod at the boundary and every failure comes back as a sentence
 * the dialog can show, never a thrown error the operator sees as a crash.
 */

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type PaymentActionResult = { ok: true; message: string } | { ok: false; message: string };

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");

const receiptFields = {
  method: z.enum(MANUAL_METHODS, { error: "Pick how they paid." }),
  amount: z.string(),
  receivedOn: ISO_DATE,
  note: z.string().max(500, "Keep the note under 500 characters.").default(""),
};

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Something in the form is not right.";
}

function refreshPages(clientPublicId?: string) {
  revalidatePath("/admin/payments");
  if (clientPublicId) revalidatePath(`/admin/clients/${clientPublicId}`);
}

const MarkPaidForm = z.object({
  requestPublicId: z.string().min(1),
  clientPublicId: z.string().min(1),
  ...receiptFields,
});

/** "Mark paid": the invoice is settled, with what actually arrived. */
export async function markPaidAction(
  _previous: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const ctx = await requireAdmin();
  const parsed = MarkPaidForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };

  const input = parsed.data;
  const amountCents = parseAmountToCents(input.amount);
  if (amountCents === null) {
    return { ok: false, message: "Enter the amount in dollars, like 25 or 25.50." };
  }

  const db = await getDb();
  const result = await confirmPaymentReceived(ctx, db, input.requestPublicId, {
    method: input.method,
    receivedOn: input.receivedOn,
    amountCents,
    note: input.note,
  });

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "not_found"
          ? "That invoice no longer exists."
          : "That invoice is cancelled or written off, so it can't be marked paid.",
    };
  }

  refreshPages(input.clientPublicId);
  return {
    ok: true,
    message: result.alreadyConfirmed
      ? "Already marked paid. Nothing was recorded twice."
      : `Recorded ${formatCurrency(amountCents)} by ${methodLabel(input.method)}. It's in the ledger.`,
  };
}

const NotPaidForm = z.object({
  requestPublicId: z.string().min(1),
  clientPublicId: z.string().min(1),
  outcome: z.enum(["still_owed", "cancel", "write_off"], { error: "Pick what happened." }),
  note: z.string().max(500, "Keep the note under 500 characters.").default(""),
});

const NOT_PAID_MESSAGE = {
  open: "Back on the overdue list. You can chase it.",
  overdue: "Still overdue. Noted that you checked today.",
  cancelled: "Charge cancelled. Nobody owes it now.",
  written_off: "Written off. It's off the overdue list.",
} as const;

/** "Not paid": keep chasing, cancel a mistake, or write it off. */
export async function notPaidAction(
  _previous: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const ctx = await requireAdmin();
  const parsed = NotPaidForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };

  const db = await getDb();
  const result = await markInvoiceNotPaid(ctx, db, parsed.data.requestPublicId, {
    outcome: parsed.data.outcome,
    note: parsed.data.note,
  });

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "not_found"
          ? "That invoice no longer exists."
          : "That invoice is already settled. Refresh the page to see where it stands.",
    };
  }

  refreshPages(parsed.data.clientPublicId);
  return { ok: true, message: NOT_PAID_MESSAGE[result.status] };
}

const RecordForm = z.object({
  clientPublicId: z.string().min(1),
  /** An unpaid invoice this settles, or empty for money with no invoice. */
  requestPublicId: z.string().default(""),
  /** One per opened dialog: a double submit records once. */
  formKey: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Reopen the form and try again."),
  /** With no invoice: the money is the website build fee. */
  coversBuild: z
    .literal("on")
    .optional()
    .transform((value) => value === "on"),
  ...receiptFields,
});

/**
 * "Record payment" from the clients list: money that came in outside Stripe.
 * Against an invoice it is exactly "Mark paid"; otherwise a ledger row of its
 * own.
 */
export async function recordPaymentAction(
  _previous: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const ctx = await requireAdmin();
  const parsed = RecordForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };

  const input = parsed.data;
  if (input.requestPublicId) return markPaidAction(_previous, formData);

  const amountCents = parseAmountToCents(input.amount);
  if (amountCents === null) {
    return { ok: false, message: "Enter the amount in dollars, like 25 or 25.50." };
  }

  const db = await getDb();
  const result = await recordManualPayment(ctx, db, {
    clientPublicId: input.clientPublicId,
    amountCents,
    method: input.method,
    receivedOn: input.receivedOn,
    note: input.note,
    idempotencyKey: `manual:${input.formKey}`,
    coversBuild: input.coversBuild,
  });

  if (!result.ok) return { ok: false, message: "That client no longer exists." };

  refreshPages(input.clientPublicId);
  return {
    ok: true,
    message: result.duplicate
      ? "Already recorded. Nothing was added twice."
      : `Recorded ${formatCurrency(amountCents)} by ${methodLabel(input.method)}. It's in the ledger.${
          input.coversBuild ? " The website build is marked paid." : ""
        }`,
  };
}
