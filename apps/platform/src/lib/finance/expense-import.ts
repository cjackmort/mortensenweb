import type { LedgerCategory } from "@/db/repositories/admin/finance";
import { LEDGER_CATEGORY_LABEL } from "./ledger-csv";
import { parseAmountToCents } from "./money";

/**
 * Many expenses at once, pasted as rows.
 *
 * For loading receipts found in Gmail or a bank export: the operator (or the
 * organizer working through their mail) pastes lines of
 * `date, description, category, amount, note`, sees what will be added, and
 * confirms. Pure, so the preview and the insert parse the same text the same
 * way — the insert never trusts a parsed copy sent back from the browser.
 *
 * Every row either parses completely or is refused with its reasons. Nothing
 * is guessed: a date that might be the 3rd of October or the 10th of March,
 * an amount with three decimals, a category nobody has heard of — each is an
 * error on that row, and the rest of the paste still goes through.
 */

/** A paste longer than this is refused as a whole: split it up. */
export const MAX_IMPORT_ROWS = 500;

const MAX_DESCRIPTION = 200;
const MAX_NOTE = 500;

export type ParsedExpenseRow =
  | {
      /** 1-based line number in the pasted text, so errors point somewhere. */
      line: number;
      ok: true;
      occurredOn: string;
      description: string;
      category: LedgerCategory;
      amountCents: number;
      note: string | null;
    }
  | { line: number; ok: false; raw: string; errors: string[] };

export interface ParseResult {
  rows: ParsedExpenseRow[];
  hadHeader: boolean;
}

type Column = "date" | "description" | "category" | "amount" | "note";

const DEFAULT_ORDER: Column[] = ["date", "description", "category", "amount", "note"];

const HEADER_NAMES: Record<string, Column> = {
  date: "date",
  day: "date",
  description: "description",
  what: "description",
  item: "description",
  payee: "description",
  vendor: "description",
  category: "category",
  type: "category",
  amount: "amount",
  total: "amount",
  cost: "amount",
  note: "note",
  notes: "note",
  memo: "note",
};

const CATEGORIES = Object.keys(LEDGER_CATEGORY_LABEL) as LedgerCategory[];

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * One line split into cells. Tabs when the paste came from a spreadsheet,
 * otherwise commas with CSV quoting: `"a, b"` is one cell and `""` inside
 * quotes is a literal quote.
 */
function splitLine(line: string, separator: "\t" | ","): string[] {
  if (separator === "\t") return line.split("\t").map((c) => c.trim());

  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === ",") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isRealDate(y: number, m: number, d: number): boolean {
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string | null {
  if (!isRealDate(y, m, d)) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * `2026-10-03`, `2026/10/03`, `10/3/2026`, `10/3/26` (US order, always) or
 * `Oct 3, 2026` / `October 3 2026`. Anything else is null.
 */
export function parseDate(raw: string): string | null {
  const text = raw.trim();

  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (isoMatch) return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (us) {
    const year = us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return iso(year, Number(us[1]), Number(us[2]));
  }

  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
    if (month === -1) return null;
    return iso(Number(named[3]), month + 1, Number(named[2]));
  }

  return null;
}

/** A category by its key or its label, in any case. Blank means "other". */
export function parseCategory(raw: string): LedgerCategory | null {
  const text = raw.trim().toLowerCase();
  if (!text) return "other";
  return (
    CATEGORIES.find((key) => key === text || LEDGER_CATEGORY_LABEL[key].toLowerCase() === text) ??
    null
  );
}

/** The column order, from a header row if the first line is one. */
function headerOrder(cells: string[]): Column[] | null {
  const mapped = cells.map((c) => HEADER_NAMES[c.trim().toLowerCase()] ?? null);
  const found = new Set(mapped.filter((c): c is Column => c !== null));
  if (!found.has("date") || !found.has("amount")) return null;
  return mapped.map((c, i) => c ?? (`ignored-${i}` as Column));
}

function parseRow(line: number, raw: string, cells: string[], order: Column[]): ParsedExpenseRow {
  const cell = (name: Column) => {
    const index = order.indexOf(name);
    return index === -1 ? "" : (cells[index] ?? "");
  };

  if (cells.filter((c) => c !== "").length < 3) {
    return {
      line,
      ok: false,
      raw,
      errors: ["Needs at least a date, a description and an amount."],
    };
  }

  const errors: string[] = [];

  const occurredOn = parseDate(cell("date"));
  if (!occurredOn) {
    errors.push(`"${cell("date")}" is not a date. Use 2026-10-03 or 10/3/2026.`);
  }

  const description = cell("description").trim();
  if (!description) errors.push("The description is empty.");
  else if (description.length > MAX_DESCRIPTION) {
    errors.push(`The description is longer than ${MAX_DESCRIPTION} characters.`);
  }

  const category = parseCategory(cell("category"));
  if (!category) {
    errors.push(`"${cell("category")}" is not a category. Use one of: ${CATEGORIES.join(", ")}.`);
  }

  const amountCents = parseAmountToCents(cell("amount"));
  if (amountCents === null) {
    errors.push(`"${cell("amount")}" is not an amount. Use a positive number like 19 or 19.99.`);
  }

  const note = cell("note").trim();
  if (note.length > MAX_NOTE) errors.push(`The note is longer than ${MAX_NOTE} characters.`);

  if (errors.length > 0 || !occurredOn || !category || amountCents === null) {
    return { line, ok: false, raw, errors };
  }

  return { line, ok: true, occurredOn, description, category, amountCents, note: note || null };
}

/**
 * Parse a paste. Throws only when the paste as a whole is too long; every
 * other problem belongs to one row.
 */
export function parseExpenseRows(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const filled = lines
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter(({ raw }) => raw.trim() !== "");

  if (filled.length === 0) return { rows: [], hadHeader: false };

  const separator = filled.some(({ raw }) => raw.includes("\t")) ? "\t" : ",";
  const first = filled[0]!;
  const fromHeader = headerOrder(splitLine(first.raw, separator));
  const body = fromHeader ? filled.slice(1) : filled;

  if (body.length > MAX_IMPORT_ROWS) {
    throw new Error(`Paste at most ${MAX_IMPORT_ROWS} rows at a time.`);
  }

  const order = fromHeader ?? DEFAULT_ORDER;
  return {
    rows: body.map(({ raw, line }) => parseRow(line, raw.trim(), splitLine(raw, separator), order)),
    hadHeader: fromHeader !== null,
  };
}

export interface ExistingExpense {
  occurredOn: string;
  amountCents: number;
  description: string;
}

/** What makes two expenses "the same receipt": date, amount, description. */
export function expenseKey(row: ExistingExpense): string {
  const description = row.description.trim().replace(/\s+/g, " ").toLowerCase();
  return `${row.occurredOn}|${row.amountCents}|${description}`;
}

export type FlaggedExpenseRow = ParsedExpenseRow & {
  /** Already in the ledger, or an earlier line of this same paste. */
  duplicateOf: "ledger" | "paste" | null;
};

/**
 * Mark the rows that look like receipts already entered. Flagged, not
 * dropped: two real $15 Figma charges on one day are possible, so the
 * operator decides.
 */
export function flagDuplicates(
  rows: ParsedExpenseRow[],
  existing: ExistingExpense[],
): FlaggedExpenseRow[] {
  const inLedger = new Set(existing.map(expenseKey));
  const seen = new Set<string>();

  return rows.map((row) => {
    if (!row.ok) return { ...row, duplicateOf: null };
    const key = expenseKey(row);
    const duplicateOf = inLedger.has(key) ? "ledger" : seen.has(key) ? "paste" : null;
    seen.add(key);
    return { ...row, duplicateOf };
  });
}
