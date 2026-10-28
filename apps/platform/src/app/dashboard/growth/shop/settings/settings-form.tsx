"use client";

import { useActionState, useState } from "react";
import type { ShopFulfilment, ShopResult, ShopSettingsView } from "@/db/repositories/client/shop-settings";
import { saveShopSettingsAction } from "../actions";

/**
 * How orders reach the customer. Shipping is one flat rate per order —
 * the thing a small shop can actually state — or the customer collects.
 * The policies are shown on the site under every product, so the client
 * writes them once, here.
 */
export function ShopSettingsForm({ settings, readOnly }: { settings: ShopSettingsView; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ShopResult | null, FormData>(saveShopSettingsAction, null);

  return (
    <form action={formAction} className="shop-settings-form">
      {/* Keyed on the save time so the fields start again from what the
          server now holds. React resets a form once its action has run,
          which puts a controlled radio back to its first value while the
          state says otherwise; a fresh mount makes the two agree. */}
      <Fields key={settings.updatedAt?.getTime() ?? 0} settings={settings} disabled={readOnly || pending} />
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={readOnly || pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function Fields({ settings, disabled }: { settings: ShopSettingsView; disabled: boolean }) {
  const [fulfilment, setFulfilment] = useState<ShopFulfilment>(settings.fulfilment);

  return (
    <>
      <fieldset className="shop-fulfilment" disabled={disabled}>
        <legend>How customers get their order</legend>
        <label className="shop-choice">
          <input
            type="radio"
            name="fulfilment"
            value="ship"
            checked={fulfilment === "ship"}
            onChange={() => setFulfilment("ship")}
          />
          <span>
            <strong>Shipped</strong>
            <span className="muted">You post it. Checkout collects a delivery address.</span>
          </span>
        </label>
        <label className="shop-choice">
          <input
            type="radio"
            name="fulfilment"
            value="pickup"
            checked={fulfilment === "pickup"}
            onChange={() => setFulfilment("pickup")}
          />
          <span>
            <strong>Pickup</strong>
            <span className="muted">The customer collects. No shipping charged.</span>
          </span>
        </label>
      </fieldset>

      {fulfilment === "ship" && (
        <div className="shop-field">
          <label htmlFor="shop-shipping">Shipping, per order</label>
          <div className="shop-money">
            <span aria-hidden="true">$</span>
            <input
              id="shop-shipping"
              name="shipping"
              inputMode="decimal"
              defaultValue={(settings.shippingCents / 100).toFixed(2)}
              disabled={disabled}
              required
            />
          </div>
          <p className="field-hint">One flat rate, added once however many items are in the order. 0 means free shipping.</p>
        </div>
      )}

      <label className="shop-check">
        <input type="checkbox" name="taxEnabled" defaultChecked={settings.taxEnabled} disabled={disabled} />
        <span>
          <strong>Add sales tax at checkout</strong>
          <span className="muted">Stripe works out the tax for the customer&apos;s address and adds it to the total.</span>
        </span>
      </label>

      <div className="shop-field">
        <label htmlFor="shop-shipping-policy">Shipping and pickup details</label>
        <textarea
          id="shop-shipping-policy"
          name="shippingPolicy"
          rows={3}
          maxLength={2000}
          defaultValue={settings.shippingPolicy ?? ""}
          disabled={disabled}
          placeholder="Orders go out within 3 working days by USPS. Pickup is from the studio, Tuesday to Saturday, 10 to 4."
        />
        <p className="field-hint">Shown on your website with every product.</p>
      </div>

      <div className="shop-field">
        <label htmlFor="shop-refund-policy">Returns and refunds</label>
        <textarea
          id="shop-refund-policy"
          name="refundPolicy"
          rows={3}
          maxLength={2000}
          defaultValue={settings.refundPolicy ?? ""}
          disabled={disabled}
          placeholder="Returns within 14 days in the original condition. Email us first and we will send the address."
        />
      </div>
    </>
  );
}
