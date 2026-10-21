"use client";

import { useActionState, useState } from "react";
import { createPromoCodeAction, deactivatePromoCodeAction, type PromoCodeResult } from "./actions";

/**
 * Make a website promo code, and switch one off. Every code made here comes
 * off the website price only; the restriction is set for you.
 */
export function NewPromoCodeForm() {
  const [state, action, pending] = useActionState<PromoCodeResult | null, FormData>(createPromoCodeAction, null);
  const [kind, setKind] = useState<"amount" | "percent">("amount");

  return (
    <form action={action} className="promo-code-form">
      <div className="profile-grid">
        <div>
          <label htmlFor="promo-code-name">Code</label>
          <input id="promo-code-name" name="code" required placeholder="WELCOME100" autoCapitalize="characters" spellCheck={false} />
        </div>
        <div>
          <label htmlFor="promo-kind">Takes off</label>
          <select id="promo-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as "amount" | "percent")}>
            <option value="amount">An amount ($)</option>
            <option value="percent">A percentage (%)</option>
          </select>
        </div>
        <div>
          <label htmlFor="promo-value">{kind === "amount" ? "Dollars off" : "Percent off"}</label>
          <input id="promo-value" name="value" inputMode="decimal" required placeholder={kind === "amount" ? "100" : "25"} />
        </div>
        <div>
          <label htmlFor="promo-expires">Expires (optional)</label>
          <input id="promo-expires" name="expiresOn" type="date" />
        </div>
        <div>
          <label htmlFor="promo-cap">Times it can be used (optional)</label>
          <input id="promo-cap" name="maxRedemptions" inputMode="numeric" placeholder="No limit" />
        </div>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Making…" : "Make code"}
      </button>
      {state && (
        <p className={state.ok ? "notice notice-success" : "error"} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function SwitchOffButton({ id, code }: { id: string; code: string }) {
  const [state, action, pending] = useActionState<PromoCodeResult | null, FormData>(deactivatePromoCodeAction, null);
  return (
    <form action={action} className="plan-action">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="secondary" disabled={pending} aria-label={`Switch off ${code}`}>
        {pending ? "Switching off…" : "Switch off"}
      </button>
      {state && !state.ok && <p className="error">{state.message}</p>}
    </form>
  );
}
