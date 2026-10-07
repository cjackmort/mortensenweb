import Link from "next/link";
import type { LedgerEntry, LedgerSummary, PeriodTotals } from "@/db/repositories/admin/finance";
import { LEDGER_CATEGORY_LABEL, methodLabel } from "@/lib/finance/ledger-csv";
import { formatCurrency } from "@/lib/payments/venmo";
import { AddExpenseForm, DeleteExpenseButton, StopRecurringButton } from "./finance-forms";

/**
 * A `date` column comes back as a bare "YYYY-MM-DD" with no time component.
 * `new Date(that string)` parses it as UTC midnight, so `toLocaleDateString`
 * in any timezone behind UTC prints the day before. Reading the parts
 * straight out of the string sidesteps the parse entirely.
 */
function formatDateOnly(isoDate: string): string {
  const [year = 1970, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function monthName(yearMonth: string): string {
  const [year = 1970, month = 1] = yearMonth.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function shiftMonth(yearMonth: string, n: number): string {
  const [y = 1970, m = 1] = yearMonth.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function Totals({ label, totals }: { label: string; totals: PeriodTotals }) {
  return (
    <>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>{label}</p>
      <div className="grid grid-4" style={{ marginBottom: "1rem" }}>
        <div className="stat">
          <p className="stat-label">Income</p>
          <p className="stat-value">{formatCurrency(totals.incomeCents)}</p>
          <p className="stat-note">client payments</p>
        </div>
        <div className="stat">
          <p className="stat-label">Fees</p>
          <p className="stat-value">{formatCurrency(totals.feesCents)}</p>
          <p className="stat-note">payment processing</p>
        </div>
        <div className="stat">
          <p className="stat-label">Expenses</p>
          <p className="stat-value">{formatCurrency(totals.expensesCents)}</p>
          <p className="stat-note">everything else</p>
        </div>
        <div className="stat">
          <p className="stat-label">Profit</p>
          <p className="stat-value">
            {totals.profitCents < 0 ? "−" : ""}
            {formatCurrency(Math.abs(totals.profitCents))}
          </p>
          <p className="stat-note">before tax</p>
        </div>
      </div>
    </>
  );
}

/**
 * The agency's books: what came in, what went out, one month at a time.
 *
 * Money in is every recorded client payment, from whichever path recorded it.
 * Money out is the expenses table, including the two kinds of row the platform
 * writes itself: Stripe's fee on each card payment, and the next month of
 * anything marked monthly (`ledger-automation.ts`). Those are labelled
 * "automatic" so nobody wonders who typed them.
 */
export function LedgerSection({
  yearMonth,
  thisMonth,
  summary,
  entries,
}: {
  yearMonth: string;
  thisMonth: string;
  summary: LedgerSummary;
  entries: LedgerEntry[];
}) {
  const year = summary.year.year;
  const atCurrent = yearMonth >= thisMonth;

  return (
    <section className="card" id="ledger">
      <div className="card-head">
        <h2>Ledger</h2>
        <span className="actions" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <a href={`/admin/payments/ledger.csv?year=${year}`}>Download {year} (CSV)</a>
          <a href={`/admin/payments/ledger.csv?year=${year - 1}`}>{year - 1}</a>
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Client payments come in on their own once they are recorded: Stripe straight away,
        Square and Venmo when you confirm them. Stripe&rsquo;s fee on each payment, and next
        month&rsquo;s row of anything marked monthly, are added automatically. The CSV is
        for your accountant.
      </p>

      <nav
        aria-label="Ledger month"
        style={{ display: "flex", alignItems: "center", gap: "1rem", margin: "0.5rem 0 1rem" }}
      >
        <Link href={`/admin/payments?month=${shiftMonth(yearMonth, -1)}#ledger`}>
          &larr; Earlier
        </Link>
        <strong>{monthName(yearMonth)}</strong>
        {!atCurrent && (
          <Link href={`/admin/payments?month=${shiftMonth(yearMonth, 1)}#ledger`}>
            Later &rarr;
          </Link>
        )}
      </nav>

      <Totals label={monthName(yearMonth)} totals={summary.month} />
      {/* The year's totals run to today, whichever of its months is shown. */}
      <Totals
        label={`${year}${String(year) === thisMonth.slice(0, 4) ? " so far" : ""}`}
        totals={summary.year}
      />

      <div className="action-block" style={{ marginTop: 0 }}>
        <AddExpenseForm />
      </div>

      {entries.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing in {monthName(yearMonth)}.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th>Category</th>
                <th>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) =>
                entry.kind === "income" ? (
                  <tr key={entry.key}>
                    <td data-label="Date">{formatDateOnly(entry.date)}</td>
                    <td data-label="What">
                      <Link href={`/admin/clients/${entry.clientPublicId}`}>
                        {entry.counterparty}
                      </Link>{" "}
                      <span className="muted">{methodLabel(entry.method)}</span>
                    </td>
                    <td data-label="Category">
                      <span className="pill pill-success">Income</span>
                    </td>
                    <td data-label="Amount">+{formatCurrency(entry.amountCents, entry.currency)}</td>
                    <td data-label="" />
                  </tr>
                ) : (
                  <tr key={entry.key}>
                    <td data-label="Date">{formatDateOnly(entry.date)}</td>
                    <td data-label="What">
                      {entry.description}
                      {entry.isRecurring && (
                        <>
                          {" "}
                          <span className="badge">monthly</span>
                        </>
                      )}
                      {entry.automatic && (
                        <>
                          {" "}
                          <span className="badge" title={entry.note ?? undefined}>
                            automatic
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label="Category">
                      <span className="pill pill-neutral">
                        {LEDGER_CATEGORY_LABEL[entry.category]}
                      </span>
                    </td>
                    <td data-label="Amount">−{formatCurrency(entry.amountCents, entry.currency)}</td>
                    <td data-label="">
                      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        {entry.isRecurring && <StopRecurringButton publicId={entry.publicId} />}
                        {/* A Stripe fee is Stripe's figure and would come straight back. */}
                        {!(entry.automatic && entry.category === "fees") && (
                          <DeleteExpenseButton publicId={entry.publicId} />
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
