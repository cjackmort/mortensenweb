import Link from "next/link";
import type { LedgerEntry, LedgerSummary, PeriodTotals } from "@/db/repositories/admin/finance";
import type { DeletedLedgerRow } from "@/db/repositories/admin/ledger-deletes";
import { formatCurrency } from "@/lib/payments/venmo";
import { AddExpenseForm } from "./finance-forms";
import { BulkAddExpenses } from "./bulk-add-expenses";
import { LedgerTable } from "./ledger-table";
import { dayLabel, instantLabel, monthName, plural, shiftMonth } from "./format";

/**
 * The agency's books: what came in, what went out, one month at a time.
 *
 * Money in is every recorded client payment, from whichever path recorded it.
 * Money out is the expenses table, including the two kinds of row the platform
 * writes itself: Stripe's fee on each card payment, and the next month of
 * anything marked monthly (`ledger-automation.ts`). Those are labelled
 * "automatic" so nobody wonders who typed them.
 */

function signed(cents: number): string {
  return `${cents < 0 ? "−" : ""}${formatCurrency(Math.abs(cents))}`;
}

function MonthTotals({ totals }: { totals: PeriodTotals }) {
  const cells = [
    ["In", formatCurrency(totals.incomeCents), "client payments"],
    ["Fees", formatCurrency(totals.feesCents), "card processing"],
    ["Expenses", formatCurrency(totals.expensesCents), "everything else"],
    ["Profit", signed(totals.profitCents), "before tax"],
  ] as const;
  return (
    <dl className="pay-strip">
      {cells.map(([label, value, note]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
          <dd className="muted">{note}</dd>
        </div>
      ))}
    </dl>
  );
}

function DeletedRows({ rows, month }: { rows: DeletedLedgerRow[]; month: string }) {
  if (rows.length === 0) return null;
  return (
    <details className="pay-fold">
      <summary>
        {plural(rows.length, "row")} deleted from {month}
      </summary>
      <ul className="pay-deleted">
        {rows.map((r) => (
          <li key={`${r.kind}:${r.publicId}`}>
            <span>
              {dayLabel(r.date)} · {r.kind === "income" ? `${r.label} payment` : r.label} ·{" "}
              {r.kind === "income" ? "+" : "−"}
              {formatCurrency(r.amountCents, r.currency)}
            </span>
            <span className="muted">
              Deleted {instantLabel(r.deletedAt)}
              {r.deletedBy ? ` by ${r.deletedBy}` : ""}
              {r.reason ? `: ${r.reason}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function LedgerSection({
  yearMonth,
  thisMonth,
  today,
  summary,
  entries,
  deleted,
}: {
  yearMonth: string;
  thisMonth: string;
  today: string;
  summary: LedgerSummary;
  entries: LedgerEntry[];
  deleted: DeletedLedgerRow[];
}) {
  const year = summary.year.year;
  const atCurrent = yearMonth >= thisMonth;
  const month = monthName(yearMonth);
  const soFar = String(year) === thisMonth.slice(0, 4) ? " so far" : "";

  return (
    <section className="card" id="ledger">
      <div className="card-head">
        <h2>Ledger</h2>
        <span className="pay-csv">
          <a href={`/admin/payments/ledger.csv?year=${year}`}>{year} CSV</a>
          <a href={`/admin/payments/ledger.csv?year=${year - 1}`}>{year - 1} CSV</a>
        </span>
      </div>

      <nav aria-label="Ledger month" className="pay-month-nav">
        <Link href={`/admin/payments?month=${shiftMonth(yearMonth, -1)}#ledger`} aria-label="Earlier month">
          &larr;
        </Link>
        <strong>{month}</strong>
        {atCurrent ? (
          <span aria-hidden="true" className="pay-month-off">
            &rarr;
          </span>
        ) : (
          <Link href={`/admin/payments?month=${shiftMonth(yearMonth, 1)}#ledger`} aria-label="Later month">
            &rarr;
          </Link>
        )}
      </nav>

      <MonthTotals totals={summary.month} />
      <p className="pay-year">
        {year}
        {soFar}: <span className="pay-nowrap">{formatCurrency(summary.year.incomeCents)} in</span>,{" "}
        <span className="pay-nowrap">
          {formatCurrency(summary.year.feesCents + summary.year.expensesCents)} out
        </span>
        , <span className="pay-nowrap">{signed(summary.year.profitCents)} profit</span>.
      </p>

      <div className="pay-tools">
        <details className="pay-fold">
          <summary>Add an expense</summary>
          <AddExpenseForm today={today} />
        </details>
        <details className="pay-fold">
          <summary>Add many at once</summary>
          <BulkAddExpenses />
        </details>
      </div>

      <LedgerTable entries={entries} monthLabel={month} />
      <DeletedRows rows={deleted} month={month} />

      <p className="pay-quiet">
        Card payments arrive on their own; Venmo, cash and checks once you mark them paid.
        Stripe&rsquo;s fee and each month of a repeating expense are added automatically. The
        CSV is for your accountant.
      </p>
    </section>
  );
}
