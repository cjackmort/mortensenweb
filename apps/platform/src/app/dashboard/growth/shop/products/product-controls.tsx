"use client";

import { useActionState } from "react";
import { deleteProductAction, setProductStatusAction, type ProductActionResult } from "./actions";

/**
 * The product page's two buttons that are not the form: on or off the
 * website, and delete. Each posts the product's public id only; the action
 * looks it up inside the caller's own organization.
 */

function Result({ state }: { state: ProductActionResult | null }) {
  if (!state) return null;
  return (
    <p className={state.ok ? "notice notice-success" : "error"} role="status">
      {state.message}
    </p>
  );
}

export function StatusToggle({ publicId, active, readOnly }: { publicId: string; active: boolean; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ProductActionResult | null, FormData>(setProductStatusAction, null);
  return (
    <form action={formAction} className="shop-control">
      <input type="hidden" name="product" value={publicId} />
      <input type="hidden" name="status" value={active ? "hidden" : "active"} />
      <button type="submit" className={active ? "secondary" : undefined} disabled={readOnly || pending}>
        {pending ? "Working…" : active ? "Take off my website" : "Put on my website"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function DeleteButton({ publicId, name, readOnly }: { publicId: string; name: string; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ProductActionResult | null, FormData>(deleteProductAction, null);
  return (
    <form
      action={formAction}
      className="shop-control"
      onSubmit={(event) => {
        if (!window.confirm(`Delete "${name}"? It leaves your website and this list. Orders already placed keep it.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="product" value={publicId} />
      <button type="submit" className="danger small" disabled={readOnly || pending}>
        {pending ? "Deleting…" : "Delete product"}
      </button>
      <Result state={state} />
    </form>
  );
}
