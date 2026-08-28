import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { adminContextFrom } from "@/db/repositories/context";
import {
  listClientBillingStatus,
  listOverduePaymentRequests,
} from "@/db/repositories/admin/billing";
import { formatCurrency } from "@/lib/payments/venmo";
import { DEFAULT_DUNNING_CONFIG } from "@/lib/billing/dunning";
import { MonthlyBillingTable } from "./monthly-billing";

export const dynamic = "force-dynamic";

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
  const [rows, billingStatus] = await Promise.all([
    listOverduePaymentRequests(ctx, db),
    listClientBillingStatus(ctx, db),
  ]);

  const awaiting = rows.filter((r) => r.awaitingConfirmation);
  const overdue = rows
    .filter((r) => !r.awaitingConfirmation)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const owed = overdue.reduce((sum, r) => sum + r.amountCents, 0);
  const pending = awaiting.reduce((sum, r) => sum + r.amountCents, 0);

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Payments</h1>
        </div>

        <div className="grid grid-3">
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
      </main>
    </AppShell>
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
