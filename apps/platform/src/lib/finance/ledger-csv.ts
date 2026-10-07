import type { LedgerCategory, LedgerEntry } from "@/db/repositories/admin/finance";

export const LEDGER_CATEGORY_LABEL: Record<LedgerCategory, string> = {
  software: "Software",
  hosting: "Hosting",
  contractor: "Contractor",
  marketing: "Marketing",
  equipment: "Equipment",
  fees: "Fees",
  other: "Other",
};

const METHOD_LABEL: Record<string, string> = {
  stripe: "Stripe",
  square: "Square",
  venmo: "Venmo",
  cash: "Cash",
  check: "Check",
  card: "Card",
  bank_transfer: "Bank transfer",
  other: "Other",
};

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

/** Excel reads a CSV without one as the system code page. */
const BOM = String.fromCharCode(0xfeff);

const HEADER = [
  "Date",
  "Type",
  "Category",
  "Client or payee",
  "Description",
  "Method",
  "Reference",
  "Amount",
  "Currency",
  "Notes",
];

/**
 * One text cell.
 *
 * Quoted always, with quotes doubled, so a comma or a line break in a
 * description cannot shift every column after it.
 *
 * A cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed
 * with an apostrophe. Spreadsheets run those as formulas, and descriptions,
 * notes and client business names are typed by people: a business named
 * `=HYPERLINK(...)` would otherwise run inside the accountant's spreadsheet.
 * Amounts are not passed through here; they are numbers the ledger made.
 */
export function csvText(value: string | null | undefined): string {
  const text = value ?? "";
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Cents as a plain decimal, signed: money in positive, money out negative. */
function amount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The ledger as a CSV an accountant can open.
 *
 * Oldest first, one row per payment or expense, signed amounts so a column
 * sum is the profit. Stripe's fee is its own row rather than netted off the
 * payment, because gross income and processing fees go on different lines of
 * a tax return.
 *
 * Starts with a byte-order mark: without it, Excel reads the file as the
 * system code page and every em dash and accented business name comes out
 * mangled.
 */
export function ledgerCsv(entries: LedgerEntry[]): string {
  const rows = [...entries].reverse().map((entry) => {
    if (entry.kind === "income") {
      return [
        entry.date,
        csvText("Income"),
        csvText("Client payment"),
        csvText(entry.counterparty),
        csvText(`${methodLabel(entry.method)} payment`),
        csvText(methodLabel(entry.method)),
        csvText(entry.reference),
        amount(entry.amountCents),
        csvText(entry.currency),
        csvText(entry.note),
      ];
    }
    return [
      entry.date,
      csvText("Expense"),
      csvText(LEDGER_CATEGORY_LABEL[entry.category]),
      csvText(""),
      csvText(entry.description),
      csvText(""),
      csvText(""),
      amount(-entry.amountCents),
      csvText(entry.currency),
      csvText(entry.note),
    ];
  });

  return `${BOM}${[HEADER.map(csvText), ...rows].map((r) => r.join(",")).join("\r\n")}\r\n`;
}
