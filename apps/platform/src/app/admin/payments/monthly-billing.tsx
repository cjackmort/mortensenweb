"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  raiseRequestAction,
  type BillingResult,
} from "../clients/[publicId]/billing-actions";
import type { ClientBillingStatus } from "@/db/repositories/admin/billing";
import { currentPeriod } from "@/lib/billing/period";
import { formatCurrency } from "@/lib/payments/venmo";

/**
 * "Who needs a bill this month" — one row per active client, so raising a
 * month's invoices is a pass down a list rather than a hunt through each
 * client's own page. Reuses `raiseRequestAction` (the same action the
 * per-client page's own form calls), so a bill raised from either place
 * behaves identically — same validation, same one-open-invoice rule.
 */

/**
 * End of the current business-timezone month, as the sensible default due
 * date for a monthly bill. `RaiseRequestForm` computes its own default with
 * raw local-time `Date` setters plus `toISOString()` — correct only until the
 * evening pushes local time past UTC midnight, at which point it silently
 * suggests the 1st of the following month instead of the last day of this
 * one. `currentPeriod()` already solves this properly (see period.ts), so
 * this one reuses it rather than repeating the same off-by-one.
 */
function defaultDueDate(): string {
  return currentPeriod().end;
}

function StandingPill({ row }: { row: ClientBillingStatus }) {
  if (row.neverBilled) {
    return <span className="pill pill-neutral">Not yet billed</span>;
  }

  const s = row.standing;
  if (s.state === "paid_up") {
    return <span className="pill pill-success">Paid up</span>;
  }
  if (s.state === "awaiting_confirmation") {
    return <span className="pill pill-info">Awaiting confirmation</span>;
  }
  if (s.state === "due") {
    return (
      <span className="pill pill-info">
        {s.daysUntilDue === 0 ? "Due today" : `Due in ${s.daysUntilDue}d`}
      </span>
    );
  }
  if (s.state === "unmanaged") {
    return <span className="pill pill-danger">{s.daysOverdue}d overdue</span>;
  }
  return <span className="pill pill-warning">{s.daysOverdue}d overdue</span>;
}

function RaiseInlineForm({
  clientPublicId,
  amountCents,
}: {
  clientPublicId: string;
  amountCents: number;
}) {
  const [state, formAction, pending] = useActionState<
    BillingResult | null,
    FormData
  >(raiseRequestAction, null);

  if (state?.ok) {
    return <span className="muted">{state.message}</span>;
  }

  return (
    <form
      action={formAction}
      className="actions"
      style={{ alignItems: "center", flexWrap: "nowrap", gap: "0.5rem" }}
    >
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input
        type="hidden"
        name="amount"
        value={(amountCents / 100).toFixed(2)}
      />
      <input
        type="date"
        name="dueOn"
        defaultValue={defaultDueDate()}
        aria-label="Due date"
        style={{ marginBottom: 0, minHeight: "2rem", width: "9.5rem" }}
      />
      <button
        type="submit"
        className="small"
        disabled={pending}
        style={{ flexShrink: 0 }}
      >
        {pending ? "Billing…" : `Bill ${formatCurrency(amountCents)}`}
      </button>
      {state && !state.ok && (
        <span className="error" style={{ margin: 0, padding: "0.2rem 0.5rem" }}>
          {state.message}
        </span>
      )}
    </form>
  );
}

export function MonthlyBillingTable({ rows }: { rows: ClientBillingStatus[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No active clients yet.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="stack">
        <thead>
          <tr>
            <th>Client</th>
            <th>Status</th>
            <th>Due / raise</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.clientPublicId}>
              <td data-label="Client">
                <Link href={`/admin/clients/${row.clientPublicId}`}>
                  {row.organizationName}
                </Link>
              </td>
              <td data-label="Status">
                <StandingPill row={row} />
              </td>
              <td data-label="Due / raise">
                {row.canRaise ? (
                  row.monthlyPriceCents ? (
                    <RaiseInlineForm
                      clientPublicId={row.clientPublicId}
                      amountCents={row.monthlyPriceCents}
                    />
                  ) : (
                    <span className="muted">No plan price set</span>
                  )
                ) : (
                  <span className="muted">
                    {row.latestRequest?.dueOn
                      ? `Ref ${row.latestRequest.reference} · due ${row.latestRequest.dueOn}`
                      : `Ref ${row.latestRequest?.reference}`}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
