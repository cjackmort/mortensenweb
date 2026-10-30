import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getBillingOverview } from "@/db/repositories/client/billing";
import { getEntitlements } from "@/db/repositories/client/entitlements";
import {
  buildVenmoPaymentUrl,
  configuredVenmoHandle,
  formatCurrency,
} from "@/lib/payments/venmo";
import { stripeConfigured } from "@/lib/payments/stripe";
import { getStripeBillingPanel } from "@/db/repositories/client/stripe-billing";
import { ExtraChangePanel } from "./extra-change-panel";
import { PayPanel } from "./pay-panel";
import { StripePanel } from "./stripe-panel";

export const dynamic = "force-dynamic";

/**
 * How a payment was made, in the client's words. The ledger's own labels
 * (`lib/finance/ledger-csv.ts`) are the operator's, but the history used to
 * show the raw stored value: "stripe", "venmo", "bank_transfer".
 *
 * `square` stays because the enum still holds it and a row could carry it.
 */
const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  venmo: "Venmo",
  check: "Check",
  card: "Card",
  bank_transfer: "Bank transfer",
  stripe: "Card",
  square: "Card",
  other: "Other",
};

/**
 * What the client owes, and how to pay it.
 *
 * The tone here is set by one rule from the plan: non-payment pauses labour,
 * never hosting. A client who is behind should not be made to feel their site
 * is about to disappear, because it isn't — so the copy says exactly what is
 * and isn't affected, at every state.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");

  if (!user.organizationId) {
    return (
      <>
        <main className="shell">
          <div className="masthead">
            <h1>Billing</h1>
          </div>
          <p className="notice">
            Your account is not yet linked to an organization. Please contact us
            and we&rsquo;ll finish setting it up.
          </p>
        </main>
      </>
    );
  }

  const ctx = tenantContextFrom(user, user.organizationId);
  const db = await getDb();
  const [overview, entitlements, stripePanel] = await Promise.all([
    getBillingOverview(db, ctx),
    getEntitlements(db, ctx),
    getStripeBillingPanel(db, ctx),
  ]);

  /**
   * Which plan the "set up automatic payment" button buys.
   *
   * Their own plan, never a default. Falling back to a house plan would let a
   * client subscribe to a tier nobody put them on, at a price nobody quoted
   * them — and they would have authorised it, which makes it hard to undo
   * gracefully. No plan means no offer, and a conversation instead.
   *
   * `entitlements.planKey` returns the *comp* plan key for a complimentary
   * client, which must never reach checkout. Three things stop it: the panel
   * only renders the offer in the `not_subscribed` state, the repository
   * refuses a client with `comp_plan_id`, and `comp-unlimited` has no price to
   * resolve. The layering is deliberate — charging a comped client is the one
   * failure here with no technical remedy.
   */
  const offerPlanKey = entitlements?.planKey ?? null;

  const locked = entitlements ? !entitlements.changeRequestsUnlocked : false;

  // Back from Stripe's payment page. Wording only: the invoice is settled by
  // the webhook, and until it lands the invoice still reads as due — this says
  // why, instead of leaving them to wonder whether to pay again.
  const { payment } = await searchParams;
  const justPaid = payment === "complete" && Boolean(overview.current);

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
    <>
      <main className="shell">
        <div className="masthead">
          <h1>Billing</h1>
          {overview.monthlyPriceCents !== null && (
            <span className="muted">
              {formatCurrency(overview.monthlyPriceCents)} per month
            </span>
          )}
        </div>

        {justPaid ? (
          <p className="notice notice-success">
            <strong>Thanks &mdash; your payment went through.</strong> It can
            take a minute to show as paid here. There&rsquo;s no need to pay
            again.
          </p>
        ) : (
          <Standing overview={overview} />
        )}

        {/* Card subscriptions. Hidden entirely when Stripe has no credentials
            in this environment, so the Venmo path below is unaffected by it
            being switched off. */}
        {stripePanel.available && (
          <StripePanel
            state={stripePanel.status.state}
            label={stripePanel.status.label}
            detail={stripePanel.status.detail}
            needsAction={stripePanel.status.needsAction}
            planName={stripePanel.planName}
            monthlyPriceCents={stripePanel.monthlyPriceCents}
            currency={stripePanel.currency}
            paidThrough={stripePanel.paidThrough?.toISOString() ?? null}
            nextChargeOn={stripePanel.nextChargeOn?.toISOString() ?? null}
            nextChargeCents={stripePanel.nextChargeCents}
            promo={
              stripePanel.promo
                ? { ...stripePanel.promo, endsAt: stripePanel.promo.endsAt?.toISOString() ?? null }
                : null
            }
            checkoutPromo={stripePanel.checkoutPromo}
            history={stripePanel.history}
            canManage={stripePanel.canManage}
            offerPlanKey={offerPlanKey}
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
                  cardAvailable={stripeConfigured()}
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

        {!locked && entitlements?.overagePerChangeCents != null && (
          <ExtraChangePanel
            amountLabel={formatCurrency(entitlements.overagePerChangeCents)}
          />
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
                      <td data-label="Method">{METHOD_LABEL[p.method] ?? p.method}</td>
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
