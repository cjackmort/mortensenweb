"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import {
  addExpense,
  deleteExpense,
  type LedgerCategory,
} from "@/db/repositories/admin/finance";

const CATEGORIES: readonly LedgerCategory[] = [
  "software",
  "hosting",
  "contractor",
  "marketing",
  "equipment",
  "fees",
  "other",
];

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type LedgerResult = { ok: true; message: string } | { ok: false; message: string };

/** Dollars as typed by a human, to whole cents. Rejects anything else. */
function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number.parseFloat(cleaned) * 100);
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}

export async function addExpenseAction(
  _previous: LedgerResult | null,
  formData: FormData,
): Promise<LedgerResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const description = String(formData.get("description") ?? "").trim();
  const categoryRaw = String(formData.get("category") ?? "other");
  const amountCents = parseAmountToCents(String(formData.get("amount") ?? ""));
  const occurredOn = String(formData.get("occurredOn") ?? "").trim();
  const isRecurring = formData.get("isRecurring") === "on";
  const note = String(formData.get("note") ?? "");

  if (!description) {
    return { ok: false, message: "What was this for?" };
  }
  if (amountCents === null) {
    return { ok: false, message: "Enter an amount in dollars, like 20 or 20.99." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return { ok: false, message: "Pick a date." };
  }
  const category = CATEGORIES.includes(categoryRaw as LedgerCategory)
    ? (categoryRaw as LedgerCategory)
    : "other";

  await addExpense(ctx, db, {
    description,
    category,
    amountCents,
    occurredOn,
    isRecurring,
    note,
  });

  revalidatePath("/admin/payments");
  return { ok: true, message: "Added to the ledger." };
}

export async function deleteExpenseAction(
  _previous: LedgerResult | null,
  formData: FormData,
): Promise<LedgerResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const publicId = String(formData.get("publicId") ?? "");
  await deleteExpense(ctx, db, publicId);

  revalidatePath("/admin/payments");
  return { ok: true, message: "Removed." };
}
