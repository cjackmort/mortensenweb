import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  currentMonth,
  ledgerEntries,
  ledgerSummary,
  monthRange,
  sumPaymentsReceivedInMonth,
} from "@/db/repositories/admin/finance";
import { listDeletedLedgerRows } from "@/db/repositories/admin/ledger-deletes";
import {
  paymentsOverview,
  type PaymentsTotals,
} from "@/db/repositories/admin/payments-overview";
import { stripeSyncStatus } from "@/db/repositories/admin/stripe-reconcile";
import { businessDate, currentPeriod } from "@/lib/billing/period";
import { stripeConfigured } from "@/lib/payments/stripe";
import { formatCurrency } from "@/lib/payments/venmo";
import { ClientsTable } from "./clients-table";
import { LedgerSection } from "./ledger-section";
import { OverdueTable } from "./overdue-table";
import { PaymentDialogs } from "./payment-dialogs";
import { StripeSync } from "./stripe-sync";
import { monthName, plural } from "./format";
import "./payments.css";

export const dynamic = "force-dynamic";

/**
 * Money, on one page, in the order the operator asks about it: how much came
 * in, who pays how, who owes, and the books.
 *
 * There is no "Waiting on you" section any more. A client who said they paid
 * is on the overdue list with a "Says they paid" badge and the same two
 * buttons as everyone else — they are a task, and the badge says so, but a
 * section of their own made the page about our data model instead of about
 * who has paid.
 */
export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  // The ledger month, from `?month=YYYY-MM`. Anything else, or a month that
  // has not happened yet, is this month.
  const thisMonth = currentMonth();
  const requested = (await searchParams).month ?? "";
  const ledgerMonth =
    /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) && requested <= thisMonth ? requested : thisMonth;

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const range = monthRange(ledgerMonth);
  const [overview, receivedThisMonth, summary, entries, deleted, stripeSync] = await Promise.all([
    paymentsOverview(ctx, db),
    sumPaymentsReceivedInMonth(ctx, db),
    ledgerSummary(ctx, db, ledgerMonth),
    ledgerEntries(ctx, db, range),
    listDeletedLedgerRows(ctx, db, range),
    stripeConfigured() ? stripeSyncStatus(db) : Promise.resolve(null),
  ]);

  const today = businessDate();
  const thisYear = thisMonth.slice(0, 4);

  return (
    <main className="shell pay-page">
      <div className="masthead">
        <h1>Payments</h1>
      </div>

      <PaymentDialogs today={today}>
        <Totals
          totals={overview.totals}
          received={receivedThisMonth}
          month={monthName(thisMonth).split(" ")[0] ?? "this month"}
        />

        <section className="card" id="clients">
          <div className="card-head">
            <h2>Clients</h2>
            <span className="muted">{plural(overview.clients.length, "client")}</span>
          </div>
          <ClientsTable
            rows={overview.clients}
            thisYear={thisYear}
            today={today}
            monthEnd={currentPeriod().end}
          />
        </section>

        <section className="card" id="overdue">
          <div className="card-head">
            <h2>Overdue</h2>
            <span className="muted">
              {overview.overdue.length === 0 ? "all clear" : plural(overview.overdue.length, "bill")}
            </span>
          </div>
          <OverdueTable items={overview.overdue} thisYear={thisYear} />
          <p className="pay-quiet">
            Reminder emails are not sent automatically yet, so chasing is up to you. &ldquo;Says
            they paid&rdquo; means the client pressed &ldquo;I&rsquo;ve paid&rdquo; in their
            portal: check Venmo for the reference, then mark it paid or not.
          </p>
        </section>
      </PaymentDialogs>

      <LedgerSection
        yearMonth={ledgerMonth}
        thisMonth={thisMonth}
        today={today}
        summary={summary}
        entries={entries}
        deleted={deleted}
      />

      {stripeSync && <StripeSync status={stripeSync} />}
    </main>
  );
}

function Totals({
  totals,
  received,
  month,
}: {
  totals: PaymentsTotals;
  received: number;
  month: string;
}) {
  const owedNote =
    totals.overdueClients === 0
      ? "nobody is late"
      : `${plural(totals.overdueClients, "client")} late`;
  return (
    <div className="grid grid-3">
      <div className="stat">
        <p className="stat-label">Received in {month}</p>
        <p className="stat-value">{formatCurrency(received)}</p>
        <p className="stat-note">money that has arrived</p>
      </div>
      <a className="stat pay-stat-link" href="#overdue">
        <p className="stat-label">Overdue</p>
        <p className="stat-value">{formatCurrency(totals.overdueCents)}</p>
        <p className="stat-note">
          {owedNote}
          {totals.saysPaidCount > 0 && ` · ${totals.saysPaidCount} say they paid`}
        </p>
      </a>
      <div className="stat">
        <p className="stat-label">Plans, each month</p>
        <p className="stat-value">{formatCurrency(totals.monthlyPlanCents)}</p>
        <p className="stat-note">
          {totals.autoCount} automatic · {totals.invoicedCount} billed by you · {totals.compCount} free
        </p>
      </div>
    </div>
  );
}
