"use client";

import { useState, useTransition } from "react";
import { LEDGER_CATEGORY_LABEL } from "@/lib/finance/ledger-csv";
import type { FlaggedExpenseRow } from "@/lib/finance/expense-import";
import { formatCurrency } from "@/lib/payments/venmo";
import {
  importExpensesAction,
  previewExpenseImportAction,
  type ImportPreview,
  type LedgerResult,
} from "./finance-actions";
import { plural } from "./format";

/**
 * Many expenses at once: paste rows, check them, add the ones that are right.
 *
 * Built for loading receipts found in Gmail. Nothing is written until the
 * operator has seen every row: the ones that could not be read say why, and
 * the ones that look like a receipt already in the ledger start unticked.
 */

const EXAMPLE = [
  "2026-10-03, Netlify Pro, hosting, 19.00",
  "10/5/2026, Figma, software, $15, team seat",
].join("\n");

function defaultTicks(rows: FlaggedExpenseRow[]): Set<number> {
  return new Set(rows.flatMap((r) => (r.ok && !r.duplicateOf ? [r.line] : [])));
}

function StatusCell({ row }: { row: FlaggedExpenseRow }) {
  if (!row.ok) {
    return (
      <span className="pay-stack">
        <span className="pill pill-danger">Can&rsquo;t read</span>
        {row.errors.map((e) => (
          <span key={e} className="pay-row-error">
            {e}
          </span>
        ))}
      </span>
    );
  }
  if (row.duplicateOf === "ledger") return <span className="pill pill-warning">Already in ledger</span>;
  if (row.duplicateOf === "paste") return <span className="pill pill-warning">Repeated above</span>;
  return <span className="pill pill-success">Ready</span>;
}

function PreviewTable({
  rows,
  ticked,
  toggle,
}: {
  rows: FlaggedExpenseRow[];
  ticked: ReadonlySet<number>;
  toggle: (line: number) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="stack pay-table pay-import">
        <thead>
          <tr>
            <th className="pay-check">Add</th>
            <th>Line</th>
            <th>Date</th>
            <th>What</th>
            <th>Category</th>
            <th className="pay-num">Amount</th>
            <th>Check</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line} className={row.ok ? undefined : "is-error"}>
              <td data-label="Add" className="pay-check">
                {row.ok ? (
                  <input
                    type="checkbox"
                    aria-label={`Add line ${row.line}`}
                    checked={ticked.has(row.line)}
                    onChange={() => toggle(row.line)}
                  />
                ) : null}
              </td>
              <td data-label="Line">{row.line}</td>
              {row.ok ? (
                <>
                  <td data-label="Date" className="pay-nowrap">{row.occurredOn}</td>
                  <td data-label="What">
                    {row.description}
                    {row.note && <span className="muted"> · {row.note}</span>}
                  </td>
                  <td data-label="Category">{LEDGER_CATEGORY_LABEL[row.category]}</td>
                  <td data-label="Amount" className="pay-num pay-money">
                    {formatCurrency(row.amountCents)}
                  </td>
                </>
              ) : (
                <td data-label="Row" colSpan={4}>
                  <code className="pay-raw">{row.raw}</code>
                </td>
              )}
              <td data-label="Check">
                <StatusCell row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summary(rows: FlaggedExpenseRow[], ticked: ReadonlySet<number>) {
  const ready = rows.filter((r) => r.ok && !r.duplicateOf).length;
  const dupes = rows.filter((r) => r.ok && r.duplicateOf).length;
  const errors = rows.filter((r) => !r.ok).length;
  const total = rows.reduce((s, r) => s + (r.ok && ticked.has(r.line) ? r.amountCents : 0), 0);
  const parts = [plural(rows.length, "row"), `${ready} ready`];
  if (dupes) parts.push(plural(dupes, "likely duplicate"));
  if (errors) parts.push(`${errors} can't be read`);
  return { text: parts.join(" · "), total };
}

export function BulkAddExpenses() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Extract<ImportPreview, { ok: true }> | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [message, setMessage] = useState<LedgerResult | null>(null);
  const [pending, start] = useTransition();

  function check() {
    setMessage(null);
    start(async () => {
      const result = await previewExpenseImportAction(text);
      if (!result.ok) {
        setPreview(null);
        setMessage(result);
        return;
      }
      setPreview(result);
      setTicked(defaultTicks(result.rows));
    });
  }

  function add() {
    start(async () => {
      const result = await importExpensesAction({ text, lines: [...ticked] });
      setMessage(result);
      if (result.ok) {
        setPreview(null);
        setText("");
      }
    });
  }

  function toggle(line: number) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }

  const info = preview ? summary(preview.rows, ticked) : null;

  return (
    <div className="pay-bulk">
      <label htmlFor="bulk-text">Paste rows: date, description, category, amount, note</label>
      <textarea
        id="bulk-text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // A preview of different text would add rows nobody checked.
          setPreview(null);
        }}
        placeholder={EXAMPLE}
        spellCheck={false}
        rows={6}
      />
      <p className="field-hint">
        One expense per line, commas or tabs (a spreadsheet copy works). A header row is fine.
        Categories: {Object.keys(LEDGER_CATEGORY_LABEL).join(", ")}; blank means other.
      </p>

      {message && (
        <p className={message.ok ? "notice notice-success" : "error"} role="status">
          {message.message}
        </p>
      )}

      {!preview && (
        <button type="button" onClick={check} disabled={pending || text.trim() === ""}>
          {pending ? "Checking…" : "Check rows"}
        </button>
      )}

      {preview && info && (
        <div className="pay-bulk-preview">
          <p className="pay-bulk-summary">{info.text}</p>
          <PreviewTable rows={preview.rows} ticked={ticked} toggle={toggle} />
          <div className="pay-actions pay-bulk-foot">
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Edit rows
            </button>
            <button type="button" onClick={add} disabled={pending || ticked.size === 0}>
              {pending
                ? "Adding…"
                : `Add ${plural(ticked.size, "expense")} · ${formatCurrency(info.total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
