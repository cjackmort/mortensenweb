import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getBillingOverview } from "@/db/repositories/client/billing";
import { getEntitlements } from "@/db/repositories/client/entitlements";
import { recurringAvailable } from "@/db/repositories/client/checkout";
import {
  buildVenmoPaymentUrl,
  configuredVenmoHandle,
  formatCurrency,
} from "@/lib/payments/venmo";
import { isSquareConfigured } from "@/lib/payments/square";
import { PayPanel } from "./pay-panel";
import { UnlockPanel } from "./unlock-panel";

export const dynamic = "force-dynamic";

/**
 * What the client owes, and how to pay it.
 *
 * The tone here is set by one rule from the plan: non-payment pauses labour,
 * never hosting. A client who is behind should not be made to feel their site
 * is about to disappear, because it isn't — so the copy says exactly what is
 * and isn't affected, at every state.
 */
export default async function BillingPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");

  if (!user.organizationId) {
    return (
      <AppShell user={user}>
        <main className="shell">
          <div className="masthead">
            <h1>Billing</h1>
          </div>
          <p className="notice">
            Your account is not yet linked to an organization. Please contact us
            and we&rsquo;ll finish setting it up.
          </p>
        </main>
      </AppShell>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const [overview, entitlements, canRecur] = await Promise.all([
    getBillingOverview(db, ctx),
    getEntitlements(db, ctx),
    recurringAvailable(db, ctx),
  ]);

  // The unlock panel is for a client who has never paid. Once they have, the
  // ordinary "amount due" flow takes over — showing both would offer someone
  // an "unlock" they already own.
  const locked = entitlements ? !entitlements.changeRequestsUnlocked : false;
  const cardAvailable = isSquareConfigured();
  // Only when nothing has been raised yet. Once an invoice exists the "amount
  // due" panel owns paying, and showing both would offer two routes to the
  // same money — with two references, only one of which gets reconciled.
  const showUnlock =
    locked && cardAvailable && !overview.current && overview.monthlyPriceCents !== null;

  const handle = configuredVenmoHandle();
  const venmoUrl =
    overview.current && handle
      ? buildVenmoPaymentUrl({
          handle,
          amountCents: overview.current.amountCents,
          reference: overview.current.reference,
          businessName: overview.businessName,
        })
      : null;

  return (
    <AppShell user={user}>
      <main className="shell">
        <div className="masthead">
          <h1>Billing</h1>
          {overview.monthlyPriceCents !== null && (
            <span className="muted">
              {formatCurrency(overview.monthlyPriceCents)} per month
            </span>
          )}
        </div>

        <Standing overview={overview} />

        {showUnlock && (
          <UnlockPanel
            amountLabel={formatCurrency(overview.monthlyPriceCents!)}
            planName={entitlements?.planName ?? null}
            recurringAvailable={canRecur}
            includesAnalytics={entitlements?.planIncludesAnalytics ?? true}
          />
        )}

        {overview.current && (
          <section className="card">
            <div className="card-head">
              <h2>Amount due</h2>
              <span className="muted">Ref {overview.current.reference}</span>
            </div>

            <p className="stat-value" style={{ marginBottom: "0.25rem" }}>
              {formatCurrency(
                overview.current.amountCents,
                overview.current.currency,
              )}
            </p>
            <p className="muted" style={{ marginTop: 0 }}>
              {overview.current.dueOn
                ? `Due ${formatDate(overview.current.dueOn)}`
                : "No due date set"}
            </p>

            {overview.current.note && (
              <p style={{ fontSize: "0.92rem" }}>{overview.current.note}</p>
            )}

            <div style={{ marginTop: "1.25rem" }}>
              {overview.current.status === "awaiting_confirmation" ? (
                <div className="notice notice-success" style={{ margin: 0 }}>
                  <strong>You&rsquo;ve told us this is paid.</strong> We&rsquo;ll
                  confirm it shortly, and you won&rsquo;t get reminders in the
                  meantime.
                </div>
              ) : (
                <PayPanel
                  requestPublicId={overview.current.publicId}
                  venmoUrl={venmoUrl}
                  cardAvailable={cardAvailable}
                  reference={overview.current.reference}
                  amount={formatCurrency(
                    overview.current.amountCents,
                    overview.current.currency,
                  )}
                />
              )}
            </div>
          </section>
        )}

        <section className="card">
          <div className="card-head">
            <h2>Payment history</h2>
            <span className="muted">{overview.history.length} recorded</span>
          </div>

          {overview.history.length === 0 ? (
            <div className="empty">
              <p className="empty-title">Nothing recorded yet.</p>
              <p>Payments appear here once we&rsquo;ve confirmed them.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.history.map((p) => (
                    <tr key={p.publicId}>
                      <td data-label="Date">{formatDate(p.receivedOn)}</td>
                      <td data-label="Amount">
                        {formatCurrency(p.amountCents, p.currency)}
                      </td>
                      <td data-label="Method">{p.method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}

/**
 * The one-line answer to "am I alright?".
 *
 * Every branch that mentions being behind also states that the site stays
 * online, because that is the client's actual fear and it is unfounded.
 */
function Standing({
  overview,
}: {
  overview: Awaited<ReturnType<typeof getBillingOverview>>;
}) {
  const s = overview.standing;

  if (s.state === "paid_up") {
    return (
      <p className="notice notice-success">
        <strong>You&rsquo;re all paid up.</strong> Nothing owing.
      </p>
    );
  }

  if (s.state === "awaiting_confirmation") {
    return (
      <p className="notice notice-info">
        <strong>Payment received — pending confirmation.</strong> We&rsquo;ll
        check it off shortly.
      </p>
    );
  }

  if (s.state === "due") {
    return (
      <p className="notice notice-info">
        {s.daysUntilDue === 0 ? (
          <>
            <strong>Due today.</strong>
          </>
        ) : (
          <>
            <strong>Due in {s.daysUntilDue} days.</strong>
          </>
        )}{" "}
        Nothing to worry about — this is just your next payment.
      </p>
    );
  }

  if (s.state === "unmanaged") {
    return (
      <p className="notice notice-danger">
        <strong>
          This is {s.daysOverdue} days past due, and we&rsquo;ve paused work on
          your site.
        </strong>{" "}
        <em>Your website is still online and will stay online.</em> What&rsquo;s
        paused is new changes and updates — those resume as soon as this is
        settled.
      </p>
    );
  }

  return (
    <p className="notice">
      <strong>This is {s.daysOverdue} days past due.</strong> Your website is
      unaffected and stays online. If something&rsquo;s wrong or the timing is
      difficult, reply to any of our emails — we&rsquo;d rather sort it out than
      chase you.
    </p>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
