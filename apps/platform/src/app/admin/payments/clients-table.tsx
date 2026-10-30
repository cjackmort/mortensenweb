import Link from "next/link";
import type {
  ClientMoneyRow,
  ClientStanding,
  UnsettledInvoice,
} from "@/db/repositories/admin/payments-overview";
import { formatCurrency } from "@/lib/payments/venmo";
import { DEFAULT_DUNNING_CONFIG } from "@/lib/billing/dunning";
import { DialogButton, type InvoiceForDialog } from "./payment-dialogs";
import { dayLabel, instantLabel, plural, PURPOSE_LABEL } from "./format";

/**
 * Every client, one row each: what plan, whether their card is charged
 * automatically, when money is next due, and whether they are paid up.
 */

export function toDialogInvoice(invoice: UnsettledInvoice, thisYear: string): InvoiceForDialog {
  return {
    publicId: invoice.publicId,
    reference: invoice.reference,
    amountCents: invoice.amountCents,
    dueLabel: invoice.dueOn ? dayLabel(invoice.dueOn, thisYear) : null,
    saysPaid: invoice.saysPaid,
    saysPaidLabel: invoice.saysPaidAt ? instantLabel(invoice.saysPaidAt) : null,
    purposeLabel: PURPOSE_LABEL[invoice.purpose] ?? "Invoice",
  };
}

export function StandingPill({ standing }: { standing: ClientStanding }) {
  switch (standing.kind) {
    case "says_paid":
      return <span className="pill pill-info">Says they paid</span>;
    case "overdue":
      return (
        <span
          className={`pill ${standing.days >= DEFAULT_DUNNING_CONFIG.finalNoticeDays ? "pill-danger" : "pill-warning"}`}
        >
          Overdue {plural(standing.days, "day")}
        </span>
      );
    case "card_failing":
      return <span className="pill pill-danger">Card declined</span>;
    case "due":
      return (
        <span className="pill pill-neutral">
          {standing.days === 0 ? "Due today" : `Due in ${plural(standing.days, "day")}`}
        </span>
      );
    case "comp":
      return <span className="pill pill-neutral">Free</span>;
    case "not_billed":
      return <span className="pill pill-neutral">Not billed yet</span>;
    case "no_plan":
      return <span className="pill pill-neutral">No plan</span>;
    case "paid_up":
      return <span className="pill pill-success">Paid up</span>;
  }
}

function PlanCell({ row }: { row: ClientMoneyRow }) {
  if (!row.planName && row.priceCents === null) return <span className="muted">No plan</span>;
  return (
    <span className="pay-stack">
      <span>{row.mode === "comp" ? "Free plan" : (row.planName ?? "Custom plan")}</span>
      {row.priceCents !== null && (
        <span className="muted">
          {formatCurrency(row.priceCents, row.currency)}/mo
          {row.discountLabel && row.listPriceCents !== null && (
            <>
              {" "}
              <s>{formatCurrency(row.listPriceCents, row.currency)}</s> {row.discountLabel}
            </>
          )}
        </span>
      )}
    </span>
  );
}

const PROVIDER_LABEL: Record<string, string> = { stripe: "Stripe", square: "Square" };

function AutoBillingCell({ row }: { row: ClientMoneyRow }) {
  if (row.mode === "auto") {
    return (
      <span className="pay-inline">
        <span className="pill pill-success">On</span>
        <span className="muted">
          Card · {PROVIDER_LABEL[row.provider ?? ""] ?? row.provider}
          {row.cancelAtPeriodEnd ? " · cancelling" : ""}
        </span>
      </span>
    );
  }
  if (row.mode === "invoiced") {
    return (
      <span className="pay-inline">
        <span className="pill pill-neutral">Off</span>
        <span className="muted">You send a bill</span>
      </span>
    );
  }
  if (row.mode === "comp") return <span className="muted">Not charged</span>;
  return <span className="muted">—</span>;
}

const NEXT_LABEL = {
  charge: "card charged",
  due: "bill due",
  bill: "send next bill",
  ends: "plan ends",
} as const;

function NextCell({ row, thisYear, today }: { row: ClientMoneyRow; thisYear: string; today: string }) {
  if (!row.next) return <span className="muted">—</span>;
  const past = row.next.kind === "due" && row.next.on < today;
  return (
    <span className="pay-stack">
      <span>{dayLabel(row.next.on, thisYear)}</span>
      <span className="muted">{past ? "was due" : NEXT_LABEL[row.next.kind]}</span>
    </span>
  );
}

function Actions({
  row,
  thisYear,
  monthEnd,
}: {
  row: ClientMoneyRow;
  thisYear: string;
  monthEnd: string;
}) {
  return (
    <span className="pay-actions">
      {row.canBill && row.priceCents !== null && row.priceCents > 0 && (
        <DialogButton
          request={{
            kind: "bill",
            clientPublicId: row.clientPublicId,
            clientName: row.organizationName,
            amountCents: row.priceCents,
            dueOn: row.next?.kind === "bill" ? row.next.on : monthEnd,
          }}
        >
          Bill {formatCurrency(row.priceCents, row.currency)}
        </DialogButton>
      )}
      <DialogButton
        request={{
          kind: "record",
          clientPublicId: row.clientPublicId,
          clientName: row.organizationName,
          planCents: row.priceCents,
          invoices: row.unsettled.map((i) => toDialogInvoice(i, thisYear)),
        }}
      >
        Record payment
      </DialogButton>
    </span>
  );
}

export function ClientsTable({
  rows,
  thisYear,
  today,
  monthEnd,
}: {
  rows: ClientMoneyRow[];
  thisYear: string;
  today: string;
  monthEnd: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No clients yet.</p>
        <p>Add one on the Clients tab and they show up here.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="stack pay-table pay-grid pay-clients">
        <thead>
          <tr>
            <th>Client</th>
            <th>Plan</th>
            <th>Automatic billing</th>
            <th>Next payment</th>
            <th>Status</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.clientPublicId}>
              <td data-label="Client" className="pay-name">
                <Link href={`/admin/clients/${row.clientPublicId}`}>{row.organizationName}</Link>
                {row.isDemo && <span className="badge">demo</span>}
              </td>
              <td data-label="Plan" className="pay-plan">
                <PlanCell row={row} />
              </td>
              <td data-label="Auto-billing" className="pay-billing">
                <AutoBillingCell row={row} />
              </td>
              <td data-label="Next" className="pay-next">
                <NextCell row={row} thisYear={thisYear} today={today} />
              </td>
              <td data-label="Status" className="pay-status">
                <StandingPill standing={row.standing} />
              </td>
              <td data-label="" className="pay-row-actions">
                <Actions row={row} thisYear={thisYear} monthEnd={monthEnd} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
