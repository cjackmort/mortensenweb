"use client";

import { useActionState } from "react";
import { attachPromoAction, type PromoFormResult } from "./billing-plan-actions";

/**
 * Giving one client a promo.
 *
 * The codes listed are the active ones in Stripe; making a promo happens
 * there. Before they pay by card the choice is saved for their checkout. Once
 * Stripe is charging them it goes onto the live subscription, which is said
 * under the button because it changes what they pay.
 */

export interface PromoChoice {
  id: string;
  code: string;
  terms: string;
  /** `YYYY-MM-DD`, or null when the code does not expire. */
  expiresOn: string | null;
  firstTimeOnly: boolean;
}

function describe(option: PromoChoice): string {
  const extras = [
    option.expiresOn ? `until ${option.expiresOn}` : null,
    option.firstTimeOnly ? "new customers only" : null,
  ].filter(Boolean);
  return `${option.code}: ${option.terms}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export function PromoForm({
  clientPublicId,
  options,
  onStripe,
  saved,
  current,
}: {
  clientPublicId: string;
  options: PromoChoice[];
  onStripe: boolean;
  /** The promo saved for their checkout, as "CODE: terms". */
  saved: string | null;
  /** The promo on their live subscription, as Stripe describes it. */
  current: string | null;
}) {
  const [state, action, pending] = useActionState<PromoFormResult | null, FormData>(
    attachPromoAction,
    null,
  );

  const status = onStripe
    ? current
      ? `On their subscription: ${current}.`
      : "No promo on their subscription."
    : saved
      ? `Saved for their checkout: ${saved}.`
      : "No promo saved. They can still type any active code on the checkout page.";

  return (
    <form action={action}>
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <p style={{ marginTop: 0 }}>{status}</p>

      {options.length === 0 ? (
        <p className="field-hint">
          There are no active promo codes in Stripe. Make one under Product catalogue → Coupons,
          add a customer-facing code to it, and it appears here.
        </p>
      ) : (
        <>
          <label htmlFor="promoCodeId">{onStripe ? "Add a promo" : "Promo for their checkout"}</label>
          <select
            id="promoCodeId"
            name="promoCodeId"
            defaultValue=""
            required={onStripe}
            style={{ marginBottom: "0.75rem" }}
          >
            {onStripe ? (
              <option value="" disabled>
                Choose a code
              </option>
            ) : (
              <option value="">No promo</option>
            )}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {describe(option)}
              </option>
            ))}
          </select>

          <p className="field-hint">
            {onStripe
              ? "They already pay by card. The promo applies from their next payment and replaces any promo already on the subscription. To take one off, use Stripe."
              : "Applied to the payment link below and to their own “Set up automatic payment” button. Nothing is charged until they check out."}
          </p>
        </>
      )}

      {state && <p className={state.ok ? "notice notice-success" : "error"}>{state.message}</p>}

      {options.length > 0 ? (
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Saving…" : onStripe ? "Apply promo" : "Save promo"}
        </button>
      ) : (
        // A saved code that has since expired has to stay removable, even
        // with nothing left in the list to replace it with.
        !onStripe &&
        saved && (
          <button type="submit" className="secondary" disabled={pending}>
            {pending ? "Removing…" : "Remove promo"}
          </button>
        )
      )}
    </form>
  );
}
