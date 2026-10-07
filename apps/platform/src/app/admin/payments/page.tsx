import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import { discountApplies } from "@/lib/payments/promos";
import {
  listClientBillingStatus,
  listOverduePaymentRequests,
} from "@/db/repositories/admin/billing";
import {
  expenseTotals,
  listActiveSubscriptions,
  listExpenses,
  sumPaymentsReceivedInMonth,
  type LedgerCategory,
} from "@/db/repositories/admin/finance";
import { formatCurrency } from "@/lib/payments/venmo";
import { DEFAULT_DUNNING_CONFIG } from "@/lib/billing/dunning";
import {
  stripeSyncStatus,
  type StripeSyncStatus,
} from "@/db/repositories/admin/stripe-reconcile";
import { stripeConfigured } from "@/lib/payments/stripe";
import { MonthlyBillingTable } from "./monthly-billing";
import { AddExpenseForm, DeleteExpenseButton } from "./finance-forms";

export const dynamic = "force-dynamic";

/**
 * A `date` column comes back as a bare "YYYY-MM-DD" with no time component.
 * `new Date(that string)` parses it as UTC midnight, so `toLocaleDateString`
 * in any timezone behind UTC prints the day before — the same trap
 * `currentPeriod()` exists to avoid on the billing forms. Reading the parts
 * straight out of the string sidesteps the parse entirely.
 */
function formatDateOnly(isoDate: string): string {
  const parts = isoDate.split("-").map(Number);
  const [year = 1970, month = 1, day = 1] = parts;
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const LEDGER_CATEGORY_LABEL: Record<LedgerCategory, string> = {
  software: "Software",
  hosting: "Hosting",
  contractor: "Contractor",
  marketing: "Marketing",
  equipment: "Equipment",
  fees: "Fees",
  other: "Other",
};

/**
 * The money queue.
 *
 * Two lists, and the split is the whole point. "Waiting on you" holds clients
 * who have said they paid — those are a task for *us*, not a debt, and must
 * never be chased. "Overdue" is the actual chase list.
 *
 * Mixing them would eventually produce the one failure the plan calls out
 * explicitly: an overdue email sent to someone who already paid.
 */
export default async function AdminPaymentsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard");

  const ctx = adminContextFrom(user);
  const db = await getDb();
  const [rows, billingStatus, activeSubscriptions, receivedThisMonth, expenseRows, ledgerTotals, stripeSync] =
    await Promise.all([
      listOverduePaymentRequests(ctx, db),
      listClientBillingStatus(ctx, db),
      listActiveSubscriptions(ctx, db),
      sumPaymentsReceivedInMonth(ctx, db),
      listExpenses(ctx, db),
      expenseTotals(ctx, db),
      stripeConfigured() ? stripeSyncStatus(db) : Promise.resolve(null),
    ]);

  const awaiting = rows.filter((r) => r.awaitingConfirmation);
  const overdue = rows
    .filter((r) => !r.awaitingConfirmation)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const owed = overdue.reduce((sum, r) => sum + r.amountCents, 0);
  const pending = awaiting.reduce((sum, r) => sum + r.amountCents, 0);

  return (
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Payments</h1>
        </div>

        <div className="grid grid-4">
          <div className="stat">
            <p className="stat-label">Received this month</p>
            <p className="stat-value">{formatCurrency(receivedThisMonth)}</p>
            <p className="stat-note">confirmed payments only</p>
          </div>
          <div className="stat">
            <p className="stat-label">Awaiting your confirmation</p>
            <p className="stat-value">{formatCurrency(pending)}</p>
            <p className="stat-note">
              {awaiting.length} client{awaiting.length === 1 ? "" : "s"} say they
              paid
            </p>
          </div>
          <div className="stat">
            <p className="stat-label">Overdue</p>
            <p className="stat-value">{formatCurrency(owed)}</p>
            <p className="stat-note">
              {overdue.length} invoice{overdue.length === 1 ? "" : "s"} past due
            </p>
          </div>
          <div className="stat">
            <p className="stat-label">Work pauses at</p>
            <p className="stat-value">{DEFAULT_DUNNING_CONFIG.pauseManagementDays}d</p>
            <p className="stat-note">hosting is never affected</p>
          </div>
        </div>

        {stripeSync && <StripeSyncCard status={stripeSync} />}

        <section className="card">
          <div className="card-head">
            <h2>Active subscriptions</h2>
            <span className="muted">{activeSubscriptions.length}</span>
          </div>

          {activeSubscriptions.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No active subscriptions yet.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Plan</th>
                    <th>Billing day</th>
                    <th>Charged via</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSubscriptions.map((s) => (
                    <tr key={s.publicId}>
                      <td data-label="Client">
                        <Link href={`/admin/clients/${s.clientPublicId}`}>
                          {s.organizationName}
                        </Link>
                      </td>
                      <td data-label="Plan">
                        {discountApplies(s) ? (
                          <>
                            {formatCurrency(s.discountedPriceCents!, s.currency)}/mo{" "}
                            <span className="muted">
                              <s>{formatCurrency(s.monthlyPriceCents, s.currency)}</s> {s.discountLabel}
                            </span>
                          </>
                        ) : (
                          <>{formatCurrency(s.monthlyPriceCents, s.currency)}/mo</>
                        )}
                      </td>
                      <td data-label="Billing day">day {s.billingDay}</td>
                      <td data-label="Charged via">
                        {s.provider ? (
                          <span className="pill pill-accent">{s.provider}</span>
                        ) : (
                          <span className="muted">manual</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted" style={{ fontSize: "0.82rem", margin: "0.9rem 0 0" }}>
            No processor is connected yet, so every plan here is charged and
            collected by hand. Once Stripe is attached, charged-via will show
            it instead of &ldquo;manual&rdquo; for whichever clients move over.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Monthly billing</h2>
            <span className="muted">{billingStatus.length} active clients</span>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Set a due date to raise this month&rsquo;s invoice for a client who
            doesn&rsquo;t have one open yet. Everyone else already has one open,
            awaiting confirmation, or settled — shown as their status instead.
          </p>
          <MonthlyBillingTable rows={billingStatus} />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Waiting on you</h2>
            <span className="muted">do not chase</span>
          </div>

          {awaiting.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nobody is waiting on a confirmation.
            </p>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                These clients have told us they&rsquo;ve paid. Reminders are
                suppressed until you confirm. Check Venmo against the reference,
                then confirm on the client&rsquo;s page.
              </p>
              <QueueTable rows={awaiting} showDays={false} />
            </>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Overdue</h2>
            <span className="muted">{overdue.length}</span>
          </div>

          {overdue.length === 0 ? (
            <div className="empty">
              <p className="empty-title">Nothing overdue.</p>
              <p>Every invoice is either paid or not yet due.</p>
            </div>
          ) : (
            <QueueTable rows={overdue} showDays />
          )}
        </section>

        <p className="muted" style={{ fontSize: "0.8rem" }}>
          Reminders are not being sent automatically yet — the dunning ladder is
          written and tested, but nothing runs it on a schedule. Until that
          exists, this page is the queue and chasing is manual.
        </p>

        <section className="card">
          <div className="card-head">
            <h2>Ledger</h2>
            <span className="muted">
              {formatCurrency(ledgerTotals.monthCents)} this month
            </span>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            What the agency itself has paid for — software, hosting,
            contractors, equipment. Kept separate from client payments above,
            so this total is what you hand an accountant at tax time, not
            mixed with money that was never yours to begin with.
          </p>

          <div className="grid grid-2" style={{ marginBottom: "1.25rem" }}>
            <div className="stat">
              <p className="stat-label">This month</p>
              <p className="stat-value">{formatCurrency(ledgerTotals.monthCents)}</p>
              <p className="stat-note">expenses recorded</p>
            </div>
            <div className="stat">
              <p className="stat-label">{ledgerTotals.taxYear} so far</p>
              <p className="stat-value">{formatCurrency(ledgerTotals.yearCents)}</p>
              <p className="stat-note">year to date</p>
            </div>
          </div>

          <div className="action-block" style={{ marginTop: 0 }}>
            <AddExpenseForm />
          </div>

          {expenseRows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing recorded yet.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {expenseRows.map((e) => (
                    <tr key={e.publicId}>
                      <td data-label="Date">{formatDateOnly(e.occurredOn)}</td>
                      <td data-label="Description">
                        {e.description}
                        {e.isRecurring && (
                          <>
                            {" "}
                            <span className="badge">monthly</span>
                          </>
                        )}
                      </td>
                      <td data-label="Category">
                        <span className="pill pill-neutral">
                          {LEDGER_CATEGORY_LABEL[e.category]}
                        </span>
                      </td>
                      <td data-label="Amount">{formatCurrency(e.amountCents)}</td>
                      <td data-label="">
                        <DeleteExpenseButton publicId={e.publicId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

/**
 * Whether Stripe and the portal agree, from the hourly check.
 *
 * Shown only when there is something to say. A healthy sync is one line of
 * muted text; a payment that reached the portal only through the check is
 * spelled out with what to fix, because the usual cause, a signing secret
 * that does not match, is invisible from anywhere else in the portal.
 */
function StripeSyncCard({ status }: { status: StripeSyncStatus }) {
  if (!status.lastRunAt) {
    return (
      <p className="muted" style={{ fontSize: "0.82rem" }}>
        Stripe has not been checked against the portal yet.
      </p>
    );
  }

  const lastRun = status.lastRunAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const healthy =
    status.ok && status.needsReview.length === 0 && status.recoveredRecently === 0;

  if (healthy) {
    return (
      <p className="muted" style={{ fontSize: "0.82rem" }}>
        Stripe and the portal agree. Last checked {lastRun}.
      </p>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Stripe sync</h2>
        <span className="muted">checked {lastRun}</span>
      </div>

      {!status.ok && (
        <p className="error" style={{ marginTop: 0 }}>
          The last check could not reach Stripe{status.error ? `: ${status.error}` : "."}
        </p>
      )}

      {status.recoveredRecently > 0 && (
        <p style={{ marginTop: 0 }}>
          <span className="pill pill-warning">webhooks not arriving</span>{" "}
          {status.recoveredRecently} payment{status.recoveredRecently === 1 ? "" : "s"} reached the portal only through this hourly check, not from Stripe
          directly. In Stripe, open Developers → Webhooks → the portal endpoint and look at a
          failed delivery: a 401 means <code>STRIPE_WEBHOOK_SECRET</code> on Netlify does not
          match that endpoint&rsquo;s signing secret (change it, then redeploy).
        </p>
      )}

      {status.repaired.length > 0 && (
        <>
          <p className="muted" style={{ marginBottom: "0.4rem" }}>Fixed by the last check</p>
          <ul style={{ marginTop: 0 }}>
            {status.repaired.map((f) => (
              <li key={`${f.kind}:${f.reference}`}>{f.detail}</li>
            ))}
          </ul>
        </>
      )}

      {status.needsReview.length > 0 && (
        <>
          <p className="muted" style={{ marginBottom: "0.4rem" }}>Needs you</p>
          <ul style={{ marginTop: 0 }}>
            {status.needsReview.map((f) => (
              <li key={`${f.kind}:${f.reference}`}>{f.detail}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function QueueTable({
  rows,
  showDays,
}: {
  rows: Awaited<ReturnType<typeof listOverduePaymentRequests>>;
  showDays: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="stack">
        <thead>
          <tr>
            <th>Client</th>
            <th>Ref</th>
            <th>Amount</th>
            <th>Due</th>
            {showDays && <th>Overdue</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.publicId}>
              <td data-label="Client">
                <Link href={`/admin/clients/${r.clientPublicId}`}>
                  {r.organizationName}
                </Link>
              </td>
              <td data-label="Ref">
                <code>{r.reference}</code>
              </td>
              <td data-label="Amount">{formatCurrency(r.amountCents)}</td>
              <td data-label="Due">{r.dueOn ?? "—"}</td>
              {showDays && (
                <td data-label="Overdue">
                  <span
                    className={`pill ${
                      r.daysOverdue >= DEFAULT_DUNNING_CONFIG.pauseManagementDays
                        ? "pill-danger"
                        : r.daysOverdue >= DEFAULT_DUNNING_CONFIG.finalNoticeDays
                          ? "pill-warning"
                          : "pill-neutral"
                    }`}
                  >
                    {r.daysOverdue} days
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
