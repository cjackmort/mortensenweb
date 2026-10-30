"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import { clearFreeBuild, setFreeBuild } from "@/db/repositories/admin/write-offs";
import { parseAmountToCents } from "@/lib/finance/money";
import { formatCurrency } from "@/lib/payments/venmo";
import type { PaymentActionResult } from "./payment-actions";

/**
 * Sites built for free, on the write-offs list. Admin only: each action
 * re-derives the admin context, because a server action is a public POST
 * endpoint whatever the page around it checks.
 */

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

const FreeBuildForm = z.object({
  clientPublicId: z.string().min(1, "Pick a client."),
  value: z.string(),
  builtOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date it launched."),
});

export async function setFreeBuildAction(
  _previous: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const ctx = await requireAdmin();
  const parsed = FreeBuildForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const valueCents = parseAmountToCents(parsed.data.value);
  if (valueCents === null) {
    return { ok: false, message: "Enter what you would normally charge, like 500." };
  }

  const db = await getDb();
  let result;
  try {
    result = await setFreeBuild(ctx, db, parsed.data.clientPublicId, {
      valueCents,
      builtOn: parsed.data.builtOn,
    });
  } catch {
    return { ok: false, message: "That date doesn't exist. Pick it from the calendar." };
  }
  if (!result.ok) return { ok: false, message: "That client no longer exists." };

  revalidatePath("/admin/payments");
  const year = parsed.data.builtOn.slice(0, 4);
  return {
    ok: true,
    message: `${result.created ? "Added" : "Saved"}: ${formatCurrency(valueCents)}, on the ${year} list.`,
  };
}

export async function clearFreeBuildAction(
  _previous: PaymentActionResult | null,
  formData: FormData,
): Promise<PaymentActionResult> {
  const ctx = await requireAdmin();
  const clientPublicId = String(formData.get("clientPublicId") ?? "");
  const db = await getDb();
  const result = await clearFreeBuild(ctx, db, clientPublicId);
  if (!result.ok) return { ok: false, message: "That client no longer exists." };

  revalidatePath("/admin/payments");
  return { ok: true, message: result.cleared ? "Removed from the list." : "It was already off the list." };
}
