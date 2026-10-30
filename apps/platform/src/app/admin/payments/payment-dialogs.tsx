"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MarkPaidForm, NotPaidForm, RecordPaymentForm, BillForm } from "./payment-forms";

/**
 * One dialog for the whole page, opened by the buttons in each row.
 *
 * Hosted above the lists rather than inside a row on purpose: marking a
 * payment revalidates the page, the overdue row it was opened from
 * disappears, and a dialog living inside that row would vanish mid-sentence
 * with its "Recorded $25" confirmation. Up here it stays put, says what
 * happened, and closes when the operator is done reading.
 *
 * A native `<dialog>` opened with `showModal()`: focus is trapped, Escape
 * closes it and the page behind is inert, with no library.
 */

export interface InvoiceForDialog {
  publicId: string;
  reference: string;
  amountCents: number;
  /** "Oct 1", or null with no due date. */
  dueLabel: string | null;
  saysPaid: boolean;
  /** "Oct 18", when they said they paid. */
  saysPaidLabel: string | null;
  /** "Monthly plan", "Extra change" … */
  purposeLabel: string;
}

export type DialogRequest =
  | { kind: "mark_paid"; clientPublicId: string; clientName: string; invoice: InvoiceForDialog }
  | { kind: "not_paid"; clientPublicId: string; clientName: string; invoice: InvoiceForDialog }
  | {
      kind: "record";
      clientPublicId: string;
      clientName: string;
      planCents: number | null;
      invoices: InvoiceForDialog[];
    }
  | {
      kind: "bill";
      clientPublicId: string;
      clientName: string;
      amountCents: number;
      dueOn: string;
    };

const OpenDialog = createContext<(request: DialogRequest) => void>(() => {});

const TITLES: Record<DialogRequest["kind"], string> = {
  mark_paid: "Mark paid",
  not_paid: "Not paid",
  record: "Record a payment",
  bill: "Send this month's bill",
};

/** A fresh key per opening: each opening gets clean forms and a new double-submit guard. */
function newFormKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function DialogBody({
  request,
  today,
  formKey,
  close,
}: {
  request: DialogRequest;
  today: string;
  formKey: string;
  close: () => void;
}) {
  switch (request.kind) {
    case "mark_paid":
      return <MarkPaidForm request={request} today={today} close={close} />;
    case "not_paid":
      return <NotPaidForm request={request} close={close} />;
    case "record":
      return <RecordPaymentForm request={request} today={today} formKey={formKey} close={close} />;
    case "bill":
      return <BillForm request={request} close={close} />;
  }
}

export function PaymentDialogs({ today, children }: { today: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState<{ request: DialogRequest; key: string } | null>(null);

  const show = useCallback((request: DialogRequest) => {
    setOpen({ request, key: newFormKey() });
  }, []);

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);

  const close = useCallback(() => dialog.current?.close(), []);

  return (
    <OpenDialog.Provider value={show}>
      {children}
      <dialog
        ref={dialog}
        className="pay-dialog"
        aria-labelledby="pay-dialog-title"
        onClose={() => setOpen(null)}
      >
        {open && (
          <>
            <div className="pay-dialog-head">
              <div>
                <h2 id="pay-dialog-title">{TITLES[open.request.kind]}</h2>
                <p className="muted">{open.request.clientName}</p>
              </div>
              <button type="button" className="pay-dialog-x" onClick={close} aria-label="Close">
                ×
              </button>
            </div>
            <DialogBody key={open.key} request={open.request} today={today} formKey={open.key} close={close} />
          </>
        )}
      </dialog>
    </OpenDialog.Provider>
  );
}

/** A row's button: opens the page's dialog with this row's details. */
export function DialogButton({
  request,
  children,
  tone = "secondary",
}: {
  request: DialogRequest;
  children: ReactNode;
  tone?: "primary" | "secondary";
}) {
  const open = useContext(OpenDialog);
  return (
    <button
      type="button"
      className={tone === "primary" ? "small" : "small secondary"}
      onClick={() => open(request)}
    >
      {children}
    </button>
  );
}
