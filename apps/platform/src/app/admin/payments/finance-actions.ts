"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom, NotFoundError } from "@/db/repositories/context";
import {
  addExpense,
  addExpenses,
  liveExpensesOn,
  stopRecurringExpense,
  type LedgerCategory,
} from "@/db/repositories/admin/finance";
import { deleteLedgerRows, MAX_BULK_DELETE } from "@/db/repositories/admin/ledger-deletes";
import {
  flagDuplicates,
  parseExpenseRows,
  type FlaggedExpenseRow,
} from "@/lib/finance/expense-import";
import { LEDGER_CATEGORY_LABEL } from "@/lib/finance/ledger-csv";
import { parseAmountToCents } from "@/lib/finance/money";
import { formatCurrency } from "@/lib/payments/venmo";

const CATEGORIES = Object.keys(LEDGER_CATEGORY_LABEL) as LedgerCategory[];

async function requireAdmin() {
  const user = await currentUser();
  if (!user || user.role !== "admin") throw new NotFoundError();
  return adminContextFrom(user);
}

export type LedgerResult = { ok: true; message: string } | { ok: false; message: string };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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

export async function stopRecurringExpenseAction(
  _previous: LedgerResult | null,
  formData: FormData,
): Promise<LedgerResult> {
  const ctx = await requireAdmin();
  const db = await getDb();

  const publicId = String(formData.get("publicId") ?? "");
  const stopped = await stopRecurringExpense(ctx, db, publicId);

  revalidatePath("/admin/payments");
  return stopped
    ? { ok: true, message: "Stopped. No more months will be added." }
    : { ok: false, message: "That expense was not repeating." };
}

const DeleteInput = z.object({
  rows: z
    .array(z.object({ kind: z.enum(["income", "expense"]), publicId: z.string().min(1).max(64) }))
    .min(1, "Pick at least one row.")
    .max(MAX_BULK_DELETE, `Delete at most ${MAX_BULK_DELETE} rows at a time.`),
  reason: z.string().max(300, "Keep the reason under 300 characters.").default(""),
});

/** Delete one ledger row or many. See `ledger-deletes.ts` for what deleting means. */
export async function deleteLedgerRowsAction(input: {
  rows: { kind: "income" | "expense"; publicId: string }[];
  reason: string;
}): Promise<LedgerResult> {
  const ctx = await requireAdmin();
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Nothing to delete." };
  }

  const db = await getDb();
  const result = await deleteLedgerRows(ctx, db, parsed.data.rows, parsed.data.reason);
  revalidatePath("/admin/payments");

  const deleted = result.deletedIncome + result.deletedExpenses;
  if (deleted === 0) {
    return {
      ok: false,
      message: "Those rows were already deleted. Refresh to see the ledger as it is.",
    };
  }

  const parts = [`Deleted ${plural(deleted, "row")}.`];
  if (result.reopenedInvoices.length > 0) {
    const list = result.reopenedInvoices.join(", ");
    parts.push(`${list} ${result.reopenedInvoices.length === 1 ? "is" : "are"} unpaid again.`);
  }
  if (result.notFound > 0) parts.push(`${plural(result.notFound, "row")} had already gone.`);
  return { ok: true, message: parts.join(" ") };
}

export type ImportPreview =
  | { ok: true; rows: FlaggedExpenseRow[]; hadHeader: boolean }
  | { ok: false; message: string };

const MAX_PASTE_CHARS = 100_000;

async function previewRows(text: string): Promise<ImportPreview> {
  if (text.length > MAX_PASTE_CHARS) {
    return { ok: false, message: "That paste is too long. Split it into a few smaller ones." };
  }

  let parsed;
  try {
    parsed = parseExpenseRows(text);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not read that." };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, message: "Paste at least one row: date, description, category, amount." };
  }

  const ctx = await requireAdmin();
  const db = await getDb();
  const dates = parsed.rows.flatMap((r) => (r.ok ? [r.occurredOn] : []));
  const existing = await liveExpensesOn(ctx, db, dates);

  return { ok: true, rows: flagDuplicates(parsed.rows, existing), hadHeader: parsed.hadHeader };
}

/** Parse a paste and check it against the ledger. Writes nothing. */
export async function previewExpenseImportAction(text: string): Promise<ImportPreview> {
  await requireAdmin();
  return previewRows(typeof text === "string" ? text : "");
}

/**
 * Add the rows the operator ticked. The text is parsed again here rather than
 * trusting a parsed copy from the browser, so what goes in is exactly what the
 * parser accepts.
 */
export async function importExpensesAction(input: {
  text: string;
  lines: number[];
}): Promise<LedgerResult> {
  const ctx = await requireAdmin();
  const preview = await previewRows(typeof input?.text === "string" ? input.text : "");
  if (!preview.ok) return preview;

  const chosen = new Set(Array.isArray(input.lines) ? input.lines.filter(Number.isInteger) : []);
  const rows = preview.rows.flatMap((r) =>
    r.ok && chosen.has(r.line)
      ? [
          {
            description: r.description,
            category: r.category,
            amountCents: r.amountCents,
            occurredOn: r.occurredOn,
            isRecurring: false,
            note: r.note ?? "",
          },
        ]
      : [],
  );

  if (rows.length === 0) return { ok: false, message: "No rows are ticked to add." };

  const db = await getDb();
  const added = await addExpenses(ctx, db, rows);
  revalidatePath("/admin/payments");

  const total = rows.reduce((sum, r) => sum + r.amountCents, 0);
  return {
    ok: true,
    message: `Added ${plural(added, "expense")}, ${formatCurrency(total)} in all.`,
  };
}
