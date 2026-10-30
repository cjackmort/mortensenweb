"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { LedgerEntry } from "@/db/repositories/admin/finance";
import { LEDGER_CATEGORY_LABEL, methodLabel } from "@/lib/finance/ledger-csv";
import { formatCurrency } from "@/lib/payments/venmo";
import { StopRecurringButton } from "./finance-forms";
import type { LedgerResult } from "./finance-actions";
import { LedgerDeleteDialog } from "./ledger-delete-dialog";
import { dayLabel, plural } from "./format";

/**
 * One month of the ledger, every row deletable: one at a time from its own
 * Delete, or several at once by ticking them. Both go through the same
 * confirm step and the same server action.
 */

function WhatCell({ entry }: { entry: LedgerEntry }) {
  if (entry.kind === "income") {
    return (
      <span className="pay-stack">
        <Link href={`/admin/clients/${entry.clientPublicId}`}>{entry.counterparty}</Link>
        <span className="muted">
          {methodLabel(entry.method)}
          {entry.settlesInvoice ? ` · ${entry.settlesInvoice}` : ""}
          {entry.note ? ` · ${entry.note}` : ""}
        </span>
      </span>
    );
  }
  return (
    <span className="pay-stack">
      <span>
        {entry.description}
        {entry.isRecurring && <span className="badge pay-tag">monthly</span>}
        {entry.automatic && (
          <span className="badge pay-tag" title={entry.note ?? undefined}>
            automatic
          </span>
        )}
      </span>
      {entry.note && !entry.automatic && <span className="muted">{entry.note}</span>}
    </span>
  );
}

function SelectionBar({
  rows,
  onDelete,
  onClear,
}: {
  rows: LedgerEntry[];
  onDelete: () => void;
  onClear: () => void;
}) {
  const income = rows.filter((r) => r.kind === "income").reduce((s, r) => s + r.amountCents, 0);
  const out = rows.filter((r) => r.kind === "expense").reduce((s, r) => s + r.amountCents, 0);
  return (
    <div className="pay-selection" role="region" aria-label="Selected rows">
      <span>
        <strong>{plural(rows.length, "row")} selected</strong>
        <span className="muted">
          {income > 0 && ` · +${formatCurrency(income)} in`}
          {out > 0 && ` · −${formatCurrency(out)} out`}
        </span>
      </span>
      <span className="pay-actions">
        <button type="button" className="small secondary" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="small danger" onClick={onDelete}>
          Delete selected
        </button>
      </span>
    </div>
  );
}

export function LedgerTable({ entries, monthLabel }: { entries: LedgerEntry[]; monthLabel: string }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<LedgerEntry[] | null>(null);
  const [result, setResult] = useState<LedgerResult | null>(null);

  // Rows that left the ledger (deleted, or the month changed) drop out of the selection.
  const chosen = useMemo(() => entries.filter((e) => selected.has(e.key)), [entries, selected]);
  const allChosen = entries.length > 0 && chosen.length === entries.length;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function done(outcome: LedgerResult) {
    setResult(outcome);
    setSelected(new Set());
    setConfirming(null);
  }

  return (
    <>
      {result && (
        <p className={result.ok ? "notice notice-success" : "error"} role="status">
          {result.message}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="muted pay-empty-month">Nothing in {monthLabel}.</p>
      ) : (
        <div className="table-wrap">
          <table className="stack pay-table pay-grid pay-ledger">
            <thead>
              <tr>
                <th className="pay-check">
                  <input
                    type="checkbox"
                    aria-label={`Select every row in ${monthLabel}`}
                    checked={allChosen}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(entries.map((e) => e.key)))}
                  />
                </th>
                <th>Date</th>
                <th>What</th>
                <th>Category</th>
                <th className="pay-num">Amount</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.key} className={selected.has(entry.key) ? "is-selected" : undefined}>
                  <td data-label="" className="pay-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${entry.kind === "income" ? entry.counterparty : entry.description}, ${dayLabel(entry.date)}`}
                      checked={selected.has(entry.key)}
                      onChange={() => toggle(entry.key)}
                    />
                  </td>
                  <td data-label="Date" className="pay-date">{dayLabel(entry.date)}</td>
                  <td data-label="What" className="pay-what">
                    <WhatCell entry={entry} />
                  </td>
                  <td data-label="Category" className="pay-cat">
                    {entry.kind === "income" ? (
                      <span className="pill pill-success">Income</span>
                    ) : (
                      <span className="pill pill-neutral">{LEDGER_CATEGORY_LABEL[entry.category]}</span>
                    )}
                  </td>
                  <td data-label="Amount" className={`pay-num pay-money ${entry.kind === "income" ? "is-in" : ""}`}>
                    {entry.kind === "income" ? "+" : "−"}
                    {formatCurrency(entry.amountCents, entry.currency)}
                  </td>
                  <td data-label="" className="pay-row-actions">
                    <span className="pay-actions">
                      {entry.kind === "expense" && entry.isRecurring && (
                        <StopRecurringButton publicId={entry.publicId} />
                      )}
                      <button type="button" className="linklike" onClick={() => setConfirming([entry])}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chosen.length > 0 && (
        <SelectionBar rows={chosen} onDelete={() => setConfirming(chosen)} onClear={() => setSelected(new Set())} />
      )}

      <LedgerDeleteDialog rows={confirming} onClose={() => setConfirming(null)} onDone={done} />
    </>
  );
}
