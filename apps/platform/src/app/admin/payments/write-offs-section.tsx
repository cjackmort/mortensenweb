import Link from "next/link";
import { BUILD } from "@mortensenweb/plans";
import { LEDGER_CATEGORY_LABEL } from "@/lib/finance/ledger-csv";
import { CPA_WARNING, type WriteOffSummary } from "@/lib/finance/write-offs";
import { formatCurrency } from "@/lib/payments/venmo";
import { DialogButton } from "./payment-dialogs";
import { dayLabel, plural } from "./format";
import "./write-offs.css";

/**
 * "Potential write-offs": the year's recorded expenses by category, and the
 * sites built for free at what they would normally cost. The total is shown
 * with and without the free sites, because those are the operator's own
 * unpaid work and a CPA may well say no to them.
 */

function yearHref(year: number, month: string | null): string {
  const params = new URLSearchParams({ wyear: String(year) });
  if (month) params.set("month", month);
  return `/admin/payments?${params.toString()}#write-offs`;
}

function Totals({ summary }: { summary: WriteOffSummary }) {
  return (
    <dl className="pay-strip">
      <div>
        <dt>Expenses</dt>
        <dd>{formatCurrency(summary.expensesCents)}</dd>
        <dd className="muted">recorded in the ledger</dd>
      </div>
      <div>
        <dt>Free sites</dt>
        <dd>{formatCurrency(summary.freeBuildsCents)}</dd>
        <dd className="muted">{plural(summary.freeBuilds.length, "site")}, at your price</dd>
      </div>
      <div className="pay-strip-total">
        <dt>Total with free sites</dt>
        <dd>{formatCurrency(summary.totalWithFreeBuildsCents)}</dd>
        <dd className="muted">ask your CPA</dd>
      </div>
      <div className="pay-strip-total">
        <dt>Without free sites</dt>
        <dd>{formatCurrency(summary.totalWithoutFreeBuildsCents)}</dd>
        <dd className="muted">expenses only</dd>
      </div>
    </dl>
  );
}

function CategoryTable({ summary }: { summary: WriteOffSummary }) {
  if (summary.categories.length === 0) {
    return <p className="muted">No expenses recorded in {summary.year}.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="pay-table pay-categories">
        <thead>
          <tr>
            <th>Category</th>
            <th className="pay-num">Rows</th>
            <th className="pay-num">Total</th>
          </tr>
        </thead>
        <tbody>
          {summary.categories.map((c) => (
            <tr key={c.category}>
              <td>{LEDGER_CATEGORY_LABEL[c.category]}</td>
              <td className="pay-num muted">{c.count}</td>
              <td className="pay-num pay-money">{formatCurrency(c.totalCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All expenses</th>
            <td />
            <td className="pay-num pay-money">{formatCurrency(summary.expensesCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function FreeBuildRows({ summary, thisYear }: { summary: WriteOffSummary; thisYear: string }) {
  if (summary.freeBuilds.length === 0) {
    return <p className="muted">No sites built for free in {summary.year}.</p>;
  }
  return (
    <ul className="pay-free-list">
      {summary.freeBuilds.map((b) => (
        <li key={b.clientPublicId}>
          <div className="pay-free-head">
            <span className="pay-stack">
              <Link href={`/admin/clients/${b.clientPublicId}`}>{b.organizationName}</Link>
              <span className="muted">Launched {dayLabel(b.builtOn, thisYear)}</span>
            </span>
            <span className="pay-money pay-free-value">{formatCurrency(b.valueCents)}</span>
          </div>
          <p className="pay-cpa">{CPA_WARNING}</p>
          <span className="pay-actions pay-free-actions">
            <DialogButton
              request={{
                kind: "free_build",
                clientPublicId: b.clientPublicId,
                clientName: b.organizationName,
                candidates: [],
                valueCents: b.valueCents,
                builtOn: b.builtOn,
              }}
            >
              Edit
            </DialogButton>
            <DialogButton
              request={{
                kind: "free_build_remove",
                clientPublicId: b.clientPublicId,
                clientName: b.organizationName,
                valueCents: b.valueCents,
              }}
            >
              Remove
            </DialogButton>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WriteOffsSection({
  summary,
  candidates,
  thisYear,
  today,
  ledgerMonth,
}: {
  summary: WriteOffSummary;
  candidates: { clientPublicId: string; organizationName: string }[];
  thisYear: string;
  today: string;
  /** Kept in the year links so changing year does not reset the ledger. */
  ledgerMonth: string | null;
}) {
  const year = summary.year;
  const atCurrent = String(year) >= thisYear;

  return (
    <section className="card" id="write-offs">
      <div className="card-head">
        <h2>Potential write-offs</h2>
        <nav aria-label="Write-offs year" className="pay-month-nav pay-year-nav">
          <Link href={yearHref(year - 1, ledgerMonth)} aria-label="Earlier year">
            &larr;
          </Link>
          <strong>{year}</strong>
          {atCurrent ? (
            <span aria-hidden="true" className="pay-month-off">
              &rarr;
            </span>
          ) : (
            <Link href={yearHref(year + 1, ledgerMonth)} aria-label="Later year">
              &rarr;
            </Link>
          )}
        </nav>
      </div>
      <p className="pay-intro">
        A starting list for your CPA, not tax advice. Expenses come from the ledger; deleted rows
        are left out.
      </p>

      <Totals summary={summary} />

      <h3 className="pay-subhead">Expenses by category</h3>
      <CategoryTable summary={summary} />

      <div className="pay-subhead-row">
        <h3 className="pay-subhead">Sites built for free</h3>
        {candidates.length > 0 && (
          <DialogButton
            request={{
              kind: "free_build",
              clientPublicId: null,
              clientName: "Add it to the write-offs list",
              candidates,
              valueCents: BUILD.priceCents,
              builtOn: today,
            }}
          >
            Add a free site
          </DialogButton>
        )}
      </div>
      <FreeBuildRows summary={summary} thisYear={thisYear} />
    </section>
  );
}
