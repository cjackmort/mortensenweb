import type { BillingPlanView, AssignablePlan } from "@/db/repositories/admin/billing-plan";
import type { listClientPaymentRequests } from "@/db/repositories/admin/billing";
import { ordinal } from "@/lib/billing/billing-day";
import { formatCurrency } from "@/lib/payments/venmo";
import { ConfirmReceivedForm, RaiseRequestForm } from "./billing-forms";
import { PaymentLinkForm, PlanForm } from "./billing-plan-forms";
import { CompPanel, type CompPlanOption } from "./comp-forms";
import { PromoForm, type PromoChoice } from "./promo-forms";
import { discountApplies } from "@/lib/payments/promos";

const INVOICE_PILL: Record<string, string> = {
  draft: "pill-neutral",
  open: "pill-info",
  awaiting_confirmation: "pill-warning",
  paid: "pill-success",
  overdue: "pill-danger",
  cancelled: "pill-neutral",
  written_off: "pill-neutral",
};

type Invoice = Awaited<ReturnType<typeof listClientPaymentRequests>>[number];

/** How they pay, in a sentence the operator can read at a glance. */
function howTheyPay(plan: BillingPlanView | null): string {
  if (!plan) return "No plan chosen yet. Pick one below and they'll be offered it at checkout.";
  const price = `${formatCurrency(plan.monthlyPriceCents, plan.currency)} a month on the ${ordinal(plan.billingDay)}${promoNote(plan)}`;
  const name = plan.planName ?? "A plan";
  if (plan.provider === "stripe") {
    const ending = plan.cancelAtPeriodEnd ? ", cancelling at the end of this period" : "";
    return `${name}, ${price}. Paying by card through Stripe${ending}.`;
  }
  if (plan.provider === "square") return `${name}, ${price}. Paying through Square.`;
  return `${name}, ${price}. Not paying by card yet.`;
}

/** ", $50 a month until Jan 6 (SPRING50: 50% off for 3 months)", or nothing. */
function promoNote(plan: BillingPlanView): string {
  if (!discountApplies(plan)) return "";
  const until = plan.discountEndsAt
    ? ` until ${plan.discountEndsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
    : "";
  return ` — ${formatCurrency(plan.discountedPriceCents!, plan.currency)} a month${until} with ${plan.discountLabel}`;
}

export function BillingSection({
  clientPublicId,
  plan,
  plans,
  defaultDay,
  cardPayments,
  invoices,
  compPlans,
  comp,
  promos,
  savedPromo,
}: {
  clientPublicId: string;
  plan: BillingPlanView | null;
  plans: AssignablePlan[];
  defaultDay: number;
  cardPayments: boolean;
  invoices: Invoice[];
  compPlans: CompPlanOption[];
  comp: { compPlanKey: string | null; compNote: string | null; paidPlanName: string | null } | null;
  /** Active Stripe promo codes. */
  promos: PromoChoice[];
  /** The promo saved for their checkout, as "CODE: terms". */
  savedPromo: string | null;
}) {
  const onStripe = plan?.provider === "stripe";

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Plan and payment day</h2>
        </div>
        <p style={{ marginTop: 0 }}>{howTheyPay(plan)}</p>

        {plan?.provider === "square" ? (
          <p className="muted">Change their plan in Square; this portal can&rsquo;t reach it.</p>
        ) : (
          <PlanForm
            clientPublicId={clientPublicId}
            plans={plans}
            currentPlanKey={plan?.planKey ?? null}
            currentDay={plan?.billingDay ?? defaultDay}
            onStripe={onStripe}
          />
        )}
      </section>

      {cardPayments && !onStripe && plan?.provider !== "square" && (
        <section className="card">
          <div className="card-head">
            <h2>Payment link</h2>
          </div>
          <PaymentLinkForm clientPublicId={clientPublicId} />
        </section>
      )}

      {cardPayments && plan?.provider !== "square" && !comp?.compPlanKey && (
        <section className="card">
          <div className="card-head">
            <h2>Promo</h2>
          </div>
          <PromoForm
            clientPublicId={clientPublicId}
            options={promos}
            onStripe={onStripe}
            saved={savedPromo}
            current={plan && discountApplies(plan) ? plan.discountLabel : null}
          />
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Invoices</h2>
          <span className="muted">{invoices.length}</span>
        </div>

        {invoices.length === 0 ? (
          <p className="muted" style={{ marginTop: 0 }}>
            No payment requests yet.
          </p>
        ) : (
          <div className="table-wrap" style={{ marginBottom: "1.25rem" }}>
            <table className="stack">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Amount</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.publicId}>
                    <td data-label="Ref">
                      <code>{inv.reference}</code>
                    </td>
                    <td data-label="Amount">{formatCurrency(inv.amountCents, inv.currency)}</td>
                    <td data-label="Due">{inv.dueOn ?? "—"}</td>
                    <td data-label="Status">
                      <span className={`pill ${INVOICE_PILL[inv.status] ?? "pill-neutral"}`}>
                        {inv.status.replace(/_/g, " ")}
                      </span>
                      {inv.status === "awaiting_confirmation" && (
                        <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}>
                          Client says they paid — not being chased
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Confirmation sits with the specific invoice it settles, so an
            operator cannot confirm the wrong one from a shared form. */}
        {invoices
          .filter((inv) => ["open", "overdue", "awaiting_confirmation"].includes(inv.status))
          .map((inv) => (
            <div key={inv.publicId} className="action-block">
              <ConfirmReceivedForm
                clientPublicId={clientPublicId}
                requestPublicId={inv.publicId}
                reference={inv.reference}
                amount={formatCurrency(inv.amountCents, inv.currency)}
              />
            </div>
          ))}

        <div className="action-block">
          <RaiseRequestForm
            clientPublicId={clientPublicId}
            suggestedAmount={plan ? (plan.monthlyPriceCents / 100).toFixed(2) : ""}
          />
        </div>
      </section>

      <CompPanel
        clientPublicId={clientPublicId}
        plans={compPlans}
        currentCompPlanId={comp?.compPlanKey ?? null}
        currentNote={comp?.compNote ?? null}
        paidPlanName={comp?.paidPlanName ?? null}
      />
    </>
  );
}
