"use client";

import { useActionState } from "react";
import { centsToInput } from "@/lib/finance/money";
import { formatCurrency } from "@/lib/payments/venmo";
import type { PaymentActionResult } from "./payment-actions";
import type { DialogRequest } from "./payment-dialogs";
import { Done, Failure, Footer } from "./payment-forms";
import { clearFreeBuildAction, setFreeBuildAction } from "./write-off-actions";

type Of<K extends DialogRequest["kind"]> = Extract<DialogRequest, { kind: K }>;

/** Add a site built for free, or change one already listed. */
export function FreeBuildForm({ request, close }: { request: Of<"free_build">; close: () => void }) {
  const [state, action, pending] = useActionState<PaymentActionResult | null, FormData>(
    setFreeBuildAction,
    null,
  );
  if (state?.ok) return <Done message={state.message} close={close} />;

  const adding = request.clientPublicId === null;
  return (
    <form action={action} className="pay-dialog-body">
      <p className="pay-dialog-lede">
        Valued at what you would normally charge. It goes on the write-offs list for your CPA to
        rule on; it never touches the ledger.
      </p>
      <Failure state={state} />
      {adding ? (
        <>
          <label htmlFor="free-client">Client</label>
          <select id="free-client" name="clientPublicId" required defaultValue="">
            <option value="" disabled>
              Pick a client
            </option>
            {request.candidates.map((c) => (
              <option key={c.clientPublicId} value={c.clientPublicId}>
                {c.organizationName}
              </option>
            ))}
          </select>
        </>
      ) : (
        <input type="hidden" name="clientPublicId" value={request.clientPublicId ?? ""} />
      )}
      <div className="pay-pair">
        <div>
          <label htmlFor="free-value">Value (USD)</label>
          <input
            id="free-value"
            name="value"
            type="text"
            inputMode="decimal"
            defaultValue={centsToInput(request.valueCents)}
            required
          />
        </div>
        <div>
          <label htmlFor="free-date">Launched on</label>
          <input id="free-date" name="builtOn" type="date" defaultValue={request.builtOn} required />
        </div>
      </div>
      <Footer
        pending={pending}
        label={adding ? "Add to list" : "Save"}
        pendingLabel="Saving…"
        close={close}
      />
    </form>
  );
}

export function RemoveFreeBuildForm({
  request,
  close,
}: {
  request: Of<"free_build_remove">;
  close: () => void;
}) {
  const [state, action, pending] = useActionState<PaymentActionResult | null, FormData>(
    clearFreeBuildAction,
    null,
  );
  if (state?.ok) return <Done message={state.message} close={close} />;

  return (
    <form action={action} className="pay-dialog-body">
      <p className="pay-dialog-lede">
        Takes the {formatCurrency(request.valueCents)} site for {request.clientName} off the
        write-offs list. Nothing else about the client changes.
      </p>
      <Failure state={state} />
      <input type="hidden" name="clientPublicId" value={request.clientPublicId} />
      <Footer pending={pending} label="Remove" pendingLabel="Removing…" close={close} danger />
    </form>
  );
}
