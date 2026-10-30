"use client";

import { useActionState, useState } from "react";
import { raiseRequestAction } from "../clients/[publicId]/billing-actions";
import { centsToInput } from "@/lib/finance/money";
import { formatCurrency } from "@/lib/payments/venmo";
import {
  markPaidAction,
  notPaidAction,
  recordPaymentAction,
  type PaymentActionResult,
} from "./payment-actions";
import type { DialogRequest, InvoiceForDialog } from "./payment-dialogs";

/**
 * The forms inside the payments dialog. Amounts are typed in dollars, the way
 * they appear on a Venmo screen; the server turns them into cents in one place.
 */

type Of<K extends DialogRequest["kind"]> = Extract<DialogRequest, { kind: K }>;

const METHODS = [
  ["venmo", "Venmo"],
  ["cash", "Cash"],
  ["check", "Check"],
  ["card", "Card"],
  ["bank_transfer", "Bank"],
  ["other", "Other"],
] as const;

/** After a successful action: what happened, and a way out. */
export function Done({ message, close }: { message: string; close: () => void }) {
  return (
    <div className="pay-dialog-body">
      <p className="notice notice-success" role="status">
        {message}
      </p>
      <div className="pay-dialog-foot">
        <button type="button" onClick={close} autoFocus>
          Done
        </button>
      </div>
    </div>
  );
}

export function Failure({ state }: { state: PaymentActionResult | null }) {
  if (!state || state.ok) return null;
  return (
    <p className="error" role="alert">
      {state.message}
    </p>
  );
}

export function Footer({
  pending,
  label,
  pendingLabel,
  close,
  danger = false,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  close: () => void;
  danger?: boolean;
}) {
  return (
    <div className="pay-dialog-foot">
      <button type="button" className="secondary" onClick={close}>
        Cancel
      </button>
      <button type="submit" className={danger ? "danger" : undefined} disabled={pending}>
        {pending ? pendingLabel : label}
      </button>
    </div>
  );
}

function MethodField({ defaultMethod = "venmo" }: { defaultMethod?: string }) {
  return (
    <fieldset className="pay-methods">
      <legend>Paid by</legend>
      <div className="pay-chip-row">
        {METHODS.map(([value, label]) => (
          <label key={value} className="pay-chip">
            <input type="radio" name="method" value={value} defaultChecked={value === defaultMethod} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ReceiptFields({
  amount,
  today,
  onAmountKey,
}: {
  amount: string;
  today: string;
  /** Changes when the amount should reset to a new default. */
  onAmountKey?: string;
}) {
  return (
    <>
      <MethodField />
      <div className="pay-pair">
        <div>
          <label htmlFor="pay-amount">Amount (USD)</label>
          <input
            key={onAmountKey}
            id="pay-amount"
            name="amount"
            type="text"
            inputMode="decimal"
            defaultValue={amount}
            required
          />
        </div>
        <div>
          <label htmlFor="pay-date">Received on</label>
          <input id="pay-date" name="receivedOn" type="date" defaultValue={today} max={today} required />
        </div>
      </div>
      <label htmlFor="pay-note">Note (optional, only you see it)</label>
      <input id="pay-note" name="note" type="text" maxLength={500} placeholder="Venmo @handle, check #1042" />
    </>
  );
}

function invoiceLine(invoice: InvoiceForDialog): string {
  const due = invoice.dueLabel ? `, due ${invoice.dueLabel}` : "";
  return `${invoice.reference} · ${formatCurrency(invoice.amountCents)} · ${invoice.purposeLabel}${due}`;
}

export function MarkPaidForm({
  request,
  today,
  close,
}: {
  request: Of<"mark_paid">;
  today: string;
  close: () => void;
}) {
  const [state, action, pending] = useActionState<PaymentActionResult | null, FormData>(
    markPaidAction,
    null,
  );
  if (state?.ok) return <Done message={state.message} close={close} />;

  const { invoice } = request;
  return (
    <form action={action} className="pay-dialog-body">
      <p className="pay-dialog-lede">
        {invoiceLine(invoice)}
        {invoice.saysPaid && invoice.saysPaidLabel && (
          <> They said they paid on {invoice.saysPaidLabel}.</>
        )}
      </p>
      <Failure state={state} />
      <input type="hidden" name="requestPublicId" value={invoice.publicId} />
      <input type="hidden" name="clientPublicId" value={request.clientPublicId} />
      <ReceiptFields amount={centsToInput(invoice.amountCents)} today={today} />
      <p className="hint">
        Settles {invoice.reference} and adds the payment to the ledger. Record what actually
        arrived; if it was less, the invoice still counts as paid.
      </p>
      <Footer pending={pending} label="Mark paid" pendingLabel="Recording…" close={close} />
    </form>
  );
}

const NOT_PAID_CHOICES = (saysPaid: boolean) =>
  [
    {
      value: "still_owed",
      title: saysPaid ? "The money never arrived" : "Still owed",
      body: saysPaid
        ? "Puts it back on the overdue list so you can chase it. They can tell you they paid again."
        : "Keeps it on the overdue list and notes that you checked today.",
    },
    {
      value: "cancel",
      title: "Cancel the charge",
      body: "It was a mistake: billed twice, or the wrong amount. Nobody owes it.",
    },
    {
      value: "write_off",
      title: "Write it off",
      body: "They owed it and won't pay. Stops chasing; kept as a bad debt.",
    },
  ] as const;

export function NotPaidForm({ request, close }: { request: Of<"not_paid">; close: () => void }) {
  const [state, action, pending] = useActionState<PaymentActionResult | null, FormData>(
    notPaidAction,
    null,
  );
  if (state?.ok) return <Done message={state.message} close={close} />;

  const { invoice } = request;
  return (
    <form action={action} className="pay-dialog-body">
      <p className="pay-dialog-lede">{invoiceLine(invoice)}</p>
      <Failure state={state} />
      <input type="hidden" name="requestPublicId" value={invoice.publicId} />
      <input type="hidden" name="clientPublicId" value={request.clientPublicId} />
      <fieldset className="pay-choices">
        <legend>What happened?</legend>
        {NOT_PAID_CHOICES(invoice.saysPaid).map((choice, i) => (
          <label key={choice.value} className="pay-choice">
            <input type="radio" name="outcome" value={choice.value} defaultChecked={i === 0} />
            <span>
              <strong>{choice.title}</strong>
              <span className="muted">{choice.body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label htmlFor="pay-note">Note (optional, only you see it)</label>
      <input id="pay-note" name="note" type="text" maxLength={500} placeholder="Nothing on Venmo as of today" />
      <p className="hint">Nothing is sent to the client.</p>
      <Footer pending={pending} label="Save" pendingLabel="Saving…" close={close} />
    </form>
  );
}

export function RecordPaymentForm({
  request,
  today,
  formKey,
  close,
}: {
  request: Of<"record">;
  today: string;
  formKey: string;
  close: () => void;
}) {
  const [state, action, pending] = useActionState<PaymentActionResult | null, FormData>(
    recordPaymentAction,
    null,
  );
  const [applies, setApplies] = useState(request.invoices[0]?.publicId ?? "");
  if (state?.ok) return <Done message={state.message} close={close} />;

  const invoice = request.invoices.find((i) => i.publicId === applies);
  const amount = invoice?.amountCents ?? request.planCents;

  return (
    <form action={action} className="pay-dialog-body">
      <p className="pay-dialog-lede">Money that came in outside Stripe: Venmo, cash, a check.</p>
      <Failure state={state} />
      <input type="hidden" name="clientPublicId" value={request.clientPublicId} />
      <input type="hidden" name="formKey" value={formKey} />
      {request.invoices.length > 0 && (
        <>
          <label htmlFor="pay-applies">What is it for?</label>
          <select
            id="pay-applies"
            name="requestPublicId"
            value={applies}
            onChange={(e) => setApplies(e.target.value)}
          >
            {request.invoices.map((i) => (
              <option key={i.publicId} value={i.publicId}>
                Pays {invoiceLine(i)}
              </option>
            ))}
            <option value="">Something else (no invoice)</option>
          </select>
        </>
      )}
      <ReceiptFields amount={amount ? centsToInput(amount) : ""} today={today} onAmountKey={applies} />
      <p className="hint">
        {invoice
          ? `Settles ${invoice.reference} and adds the payment to the ledger.`
          : "Adds the payment to the ledger. Any open invoice stays open."}
      </p>
      <Footer pending={pending} label="Record payment" pendingLabel="Recording…" close={close} />
    </form>
  );
}

export function BillForm({ request, close }: { request: Of<"bill">; close: () => void }) {
  const [state, action, pending] = useActionState<PaymentActionResult | null, FormData>(
    raiseRequestAction,
    null,
  );
  if (state?.ok) return <Done message={state.message} close={close} />;

  return (
    <form action={action} className="pay-dialog-body">
      <p className="pay-dialog-lede">
        Raises an invoice they can see and pay in their portal. Nothing is emailed.
      </p>
      <Failure state={state} />
      <input type="hidden" name="clientPublicId" value={request.clientPublicId} />
      <div className="pay-pair">
        <div>
          <label htmlFor="bill-amount">Amount (USD)</label>
          <input
            id="bill-amount"
            name="amount"
            type="text"
            inputMode="decimal"
            defaultValue={centsToInput(request.amountCents)}
            required
          />
        </div>
        <div>
          <label htmlFor="bill-due">Due</label>
          <input id="bill-due" name="dueOn" type="date" defaultValue={request.dueOn} required />
        </div>
      </div>
      <label htmlFor="bill-note">Note (optional, the client sees it)</label>
      <input id="bill-note" name="note" type="text" maxLength={200} placeholder="Website care, November" />
      <Footer pending={pending} label="Send bill" pendingLabel="Raising…" close={close} />
    </form>
  );
}
