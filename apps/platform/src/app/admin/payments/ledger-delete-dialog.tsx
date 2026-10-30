"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { LedgerEntry } from "@/db/repositories/admin/finance";
import { formatCurrency } from "@/lib/payments/venmo";
import { deleteLedgerRowsAction, type LedgerResult } from "./finance-actions";
import { dayLabel, plural } from "./format";
import "./payment-dialog.css";

/**
 * "Delete these?" — asked once, in place, with what deleting will do.
 *
 * The consequences are listed only when they apply: an invoice going back to
 * unpaid, a Stripe payment that will not come back with the next sync, a
 * monthly expense that stops repeating. Deleting is easy; being surprised by
 * what it did afterwards is what this is here to prevent.
 */

const SHOWN = 6;

function label(entry: LedgerEntry): string {
  return entry.kind === "income" ? `${entry.counterparty} payment` : entry.description;
}

function consequences(rows: LedgerEntry[]): string[] {
  const income = rows.filter((r) => r.kind === "income");
  const expenses = rows.filter((r) => r.kind === "expense");
  const notes: string[] = [];

  if (income.length > 0) {
    notes.push(
      "Payments leave the ledger and every total, and are kept in the deleted list with who deleted them. The client keeps access to their portal.",
    );
  }
  const reopened = income.flatMap((r) => (r.kind === "income" && r.settlesInvoice ? [r.settlesInvoice] : []));
  if (reopened.length > 0) {
    notes.push(`${reopened.join(", ")} ${reopened.length === 1 ? "goes" : "go"} back to unpaid.`);
  }
  if (income.some((r) => r.kind === "income" && r.provider === "stripe")) {
    notes.push("Stripe payments stay deleted when Stripe syncs. To give money back, refund it in Stripe.");
  }
  if (expenses.some((r) => r.kind === "expense" && r.automatic)) {
    notes.push("Automatic rows (Stripe fees, monthly repeats) are not added back.");
  }
  if (expenses.some((r) => r.kind === "expense" && r.isRecurring)) {
    notes.push("A monthly expense you delete stops repeating.");
  }
  return notes;
}

export function LedgerDeleteDialog({
  rows,
  onClose,
  onDone,
}: {
  /** The rows to delete; null when the dialog is closed. */
  rows: LedgerEntry[] | null;
  onClose: () => void;
  onDone: (result: LedgerResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (rows && !dialog.current?.open) {
      setReason("");
      setError(null);
      dialog.current?.showModal();
    }
    if (!rows && dialog.current?.open) dialog.current.close();
  }, [rows]);

  const list = rows ?? [];
  const hasIncome = list.some((r) => r.kind === "income");

  function confirm() {
    start(async () => {
      const result = await deleteLedgerRowsAction({
        rows: list.map((r) => ({ kind: r.kind, publicId: r.publicId })),
        reason,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone(result);
    });
  }

  return (
    <dialog ref={dialog} className="pay-dialog" aria-labelledby="ledger-delete-title" onClose={onClose}>
      <div className="pay-dialog-head">
        <h2 id="ledger-delete-title">
          Delete {list.length === 1 ? "this row" : plural(list.length, "row")}?
        </h2>
        <button type="button" className="pay-dialog-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="pay-dialog-body">
        <ul className="pay-delete-list">
          {list.slice(0, SHOWN).map((r) => (
            <li key={r.key}>
              <span>
                {dayLabel(r.date)} · {label(r)}
              </span>
              <span className="pay-money">
                {r.kind === "income" ? "+" : "−"}
                {formatCurrency(r.amountCents, r.currency)}
              </span>
            </li>
          ))}
          {list.length > SHOWN && <li className="muted">and {plural(list.length - SHOWN, "more row")}</li>}
        </ul>
        <ul className="pay-consequences">
          {consequences(list).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        {hasIncome && (
          <>
            <label htmlFor="delete-reason">Why (optional, kept with the deleted payment)</label>
            <input
              id="delete-reason"
              type="text"
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Marked against the wrong client"
            />
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="pay-dialog-foot">
          {/* Focus lands on the safe choice: Enter must never delete by accident. */}
          <button type="button" className="secondary" onClick={onClose} autoFocus>
            Keep {list.length === 1 ? "it" : "them"}
          </button>
          <button type="button" className="danger" onClick={confirm} disabled={pending}>
            {pending ? "Deleting…" : `Delete ${list.length === 1 ? "row" : plural(list.length, "row")}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
