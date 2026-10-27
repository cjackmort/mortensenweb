"use client";

import { useActionState } from "react";
import type { OrderResult } from "@/db/repositories/client/shop-orders";
import { markShippedAction, restockAction } from "./actions";

/** One button per order, posting only its public id. */

function Result({ state }: { state: OrderResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

export function MarkShippedButton({ publicId, pickup, readOnly }: { publicId: string; pickup: boolean; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<OrderResult | null, FormData>(markShippedAction, null);
  return (
    <form action={formAction} className="shop-control">
      <input type="hidden" name="order" value={publicId} />
      <button type="submit" className="small" disabled={readOnly || pending}>
        {pending ? "Working…" : pickup ? "Mark collected" : "Mark shipped"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function RestockButton({ publicId, readOnly }: { publicId: string; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<OrderResult | null, FormData>(restockAction, null);
  return (
    <form
      action={formAction}
      className="shop-control"
      onSubmit={(event) => {
        if (!window.confirm("Put these units back on the shelf? Only do this if the goods came back in a state you can sell.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="order" value={publicId} />
      <button type="submit" className="secondary small" disabled={readOnly || pending}>
        {pending ? "Working…" : "Restock"}
      </button>
      <Result state={state} />
    </form>
  );
}
