import Link from "next/link";
import type { OverdueItem } from "@/db/repositories/admin/payments-overview";
import { DEFAULT_DUNNING_CONFIG } from "@/lib/billing/dunning";
import { formatCurrency } from "@/lib/payments/venmo";
import { DialogButton } from "./payment-dialogs";
import { toDialogInvoice } from "./clients-table";
import { dayLabel, instantLabel, plural, PURPOSE_LABEL } from "./format";

/**
 * Everyone who owes money, with the two answers the operator gives: they
 * paid, or they did not.
 *
 * A client who pressed "I've paid" sits here too, marked and first, rather
 * than in a section of their own. They are waiting on us, and the badge says
 * so; the reminder ladder still never chases them.
 */

function lateness(item: Extract<OverdueItem, { kind: "invoice" }>, thisYear: string) {
  const { invoice } = item;
  if (invoice.daysOverdue < 1) {
    return <span className="muted">{invoice.dueOn ? `due ${dayLabel(invoice.dueOn, thisYear)}` : "—"}</span>;
  }
  const tone =
    invoice.daysOverdue >= DEFAULT_DUNNING_CONFIG.finalNoticeDays ? "pay-late-bad" : "pay-late";
  return <span className={tone}>{plural(invoice.daysOverdue, "day")}</span>;
}

function InvoiceRow({
  item,
  thisYear,
}: {
  item: Extract<OverdueItem, { kind: "invoice" }>;
  thisYear: string;
}) {
  const { invoice } = item;
  const dialogInvoice = toDialogInvoice(invoice, thisYear);
  const base = { clientPublicId: item.clientPublicId, clientName: item.organizationName, invoice: dialogInvoice };

  return (
    <tr className={invoice.saysPaid ? "pay-says-paid" : undefined}>
      <td data-label="Client" className="pay-name">
        <span className="pay-stack">
          <Link href={`/admin/clients/${item.clientPublicId}`}>{item.organizationName}</Link>
          {invoice.saysPaid && (
            <span className="pill pill-info">
              Says they paid{dialogInvoice.saysPaidLabel ? ` · ${dialogInvoice.saysPaidLabel}` : ""}
            </span>
          )}
        </span>
      </td>
      <td data-label="For" className="pay-for">
        <span className="pay-stack">
          <span>{PURPOSE_LABEL[invoice.purpose] ?? "Invoice"}</span>
          <code className="muted">{invoice.reference}</code>
        </span>
      </td>
      <td data-label="Owed" className="pay-money">
        {formatCurrency(invoice.amountCents, invoice.currency)}
      </td>
      <td data-label="Late" className="pay-when">
        <span className="pay-stack">
          {lateness(item, thisYear)}
          {invoice.lastCheckedAt && (
            <span className="muted">checked {instantLabel(invoice.lastCheckedAt)}</span>
          )}
        </span>
      </td>
      <td data-label="" className="pay-row-actions">
        <span className="pay-actions">
          <DialogButton tone="primary" request={{ kind: "mark_paid", ...base }}>
            Mark paid
          </DialogButton>
          <DialogButton request={{ kind: "not_paid", ...base }}>Not paid</DialogButton>
        </span>
      </td>
    </tr>
  );
}

function CardRow({ item }: { item: Extract<OverdueItem, { kind: "card" }> }) {
  return (
    <tr>
      <td data-label="Client" className="pay-name">
        <span className="pay-stack">
          <Link href={`/admin/clients/${item.clientPublicId}`}>{item.organizationName}</Link>
          <span className="pill pill-danger">Card declined</span>
        </span>
      </td>
      <td data-label="For" className="pay-for">
        <span className="pay-stack">
          <span>Monthly plan</span>
          <span className="muted">Stripe · {item.providerStatus.replace("_", " ")}</span>
        </span>
      </td>
      <td data-label="Owed" className="pay-money">
        {formatCurrency(item.amountCents, item.currency)}
      </td>
      <td data-label="Late" className="pay-when">
        <span className="muted">Stripe retries</span>
      </td>
      <td data-label="" className="pay-row-actions">
        <span className="pay-actions">
          <Link className="button small secondary" href={`/admin/clients/${item.clientPublicId}`}>
            Open client
          </Link>
        </span>
      </td>
    </tr>
  );
}

export function OverdueTable({ items, thisYear }: { items: OverdueItem[]; thisYear: string }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">Nobody owes you anything.</p>
        <p>Every bill is paid or not due yet.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="stack pay-table pay-grid pay-overdue">
        <thead>
          <tr>
            <th>Client</th>
            <th>For</th>
            <th>Owed</th>
            <th>Late</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) =>
            item.kind === "invoice" ? (
              <InvoiceRow key={item.invoice.publicId} item={item} thisYear={thisYear} />
            ) : (
              <CardRow key={`card:${item.clientPublicId}`} item={item} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
