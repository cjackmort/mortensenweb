import { isEmailAddress } from "@/lib/growth/lead-reply";

/**
 * Past customers from a spreadsheet: parse, map columns, normalise, dedupe.
 *
 * Every export looks different — Jobber, Housecall Pro, QuickBooks, a sheet
 * someone kept by hand — so the client confirms which column is which before
 * anything is imported. `guessMapping` only pre-fills that choice; a column
 * it is not sure of is left unmapped rather than guessed, because importing
 * a "Notes" column as names is worse than asking.
 *
 * DB-free, so every rule is unit-tested; `db/repositories/client/winback-contacts.ts`
 * does the dedupe against contacts already held.
 */

/** One import; a business with more past customers imports in batches. */
export const MAX_IMPORT_ROWS = 5000;
/** About 1 MB of text: far above 5,000 ordinary rows, far below a function's memory. */
export const MAX_IMPORT_BYTES = 1_000_000;
const MAX_NAME = 120;
const MAX_NOTE = 200;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

function delimiterOf(firstLine: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<"," | ";" | "\t", number>;
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as "," | ";" | "\t"] += 1;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

/** RFC 4180, plus the semicolon and tab exports spreadsheet apps produce. */
export function parseCsv(text: string): ParsedCsv {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = delimiterOf(source.split(/\r?\n/, 1)[0] ?? "");

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonBlank = records.filter((r) => r.some((value) => value.trim() !== ""));
  const [headerRow, ...rows] = nonBlank;
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`One import takes at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} customers. Split the file and import it in parts.`);
  }
  return { headers: (headerRow ?? []).map((h) => h.trim()), rows };
}

export interface ColumnMapping {
  email: number | null;
  /** A single "Name" column. */
  name: number | null;
  firstName: number | null;
  lastName: number | null;
  /** Their last job's date. */
  lastJob: number | null;
  /** A short note of what the job was. */
  note: number | null;
}

export const MAPPING_FIELDS: Array<{ key: keyof ColumnMapping; label: string }> = [
  { key: "email", label: "Email (required)" },
  { key: "name", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "lastJob", label: "Date of last job" },
  { key: "note", label: "What the job was" },
];

const PATTERNS: Array<[keyof ColumnMapping, RegExp]> = [
  ["email", /^(e-?mail|email address|e-?mail address|customer e-?mail|contact e-?mail)$/i],
  ["firstName", /^(first|first name|given name|firstname)$/i],
  ["lastName", /^(last|last name|surname|family name|lastname)$/i],
  ["name", /^(name|full name|customer|customer name|client|client name|contact|contact name)$/i],
  ["lastJob", /^(last (job|service|visit|appointment)( date)?|(job|service|visit|invoice|appointment) date|date)$/i],
  ["note", /^((job )?notes?|job|service|description|work done|job description)$/i],
];

export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = { email: null, name: null, firstName: null, lastName: null, lastJob: null, note: null };
  const taken = new Set<number>();
  for (const [key, pattern] of PATTERNS) {
    const index = headers.findIndex((h, i) => !taken.has(i) && pattern.test(h.trim()));
    if (index >= 0) {
      mapping[key] = index;
      taken.add(index);
    }
  }
  return mapping;
}

export interface ImportedContact {
  email: string;
  name: string | null;
  lastJobOn: string | null;
  note: string | null;
}

export type SkipReason = "no_email" | "duplicate";

export interface MappedRows {
  contacts: ImportedContact[];
  /** `row` is the spreadsheet's row number, header included, as the client sees it. */
  skipped: Array<{ row: number; reason: SkipReason }>;
}

function cell(row: string[], index: number | null): string {
  if (index === null) return "";
  return (row[index] ?? "").replace(/\s+/g, " ").trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2025-11-03`, `11/3/2025`, `11/3/25` → `2025-11-03`. Anything else → null. */
export function readDate(value: string): string | null {
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3]!.length === 2 ? `20${us[3]}` : us[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function mapRows(parsed: ParsedCsv, mapping: ColumnMapping): MappedRows {
  if (mapping.email === null) throw new Error("Choose which column holds the email address.");

  const seen = new Set<string>();
  const contacts: ImportedContact[] = [];
  const skipped: MappedRows["skipped"] = [];

  parsed.rows.forEach((row, i) => {
    const rowNumber = i + 2;
    const email = normaliseEmail(cell(row, mapping.email));
    if (!isEmailAddress(email)) {
      skipped.push({ row: rowNumber, reason: "no_email" });
      return;
    }
    if (seen.has(email)) {
      skipped.push({ row: rowNumber, reason: "duplicate" });
      return;
    }
    seen.add(email);

    const joined = [cell(row, mapping.firstName), cell(row, mapping.lastName)].filter(Boolean).join(" ");
    const name = (cell(row, mapping.name) || joined).slice(0, MAX_NAME) || null;
    const note = cell(row, mapping.note).slice(0, MAX_NOTE) || null;
    contacts.push({ email, name, lastJobOn: readDate(cell(row, mapping.lastJob)), note });
  });

  return { contacts, skipped };
}
