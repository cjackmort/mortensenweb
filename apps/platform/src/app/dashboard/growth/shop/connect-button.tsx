"use client";

import { useActionState } from "react";
import type { ShopResult } from "@/db/repositories/client/shop-settings";
import { connectStripeAction } from "./actions";

/**
 * The one button that leaves the portal: it sends the client to Stripe's
 * onboarding in their own name. On success the action redirects, so the
 * only state that ever renders here is a refusal.
 */
export function ConnectStripeButton({ label, readOnly }: { label: string; readOnly: boolean }) {
  const [state, formAction, pending] = useActionState<ShopResult | null, FormData>(connectStripeAction, null);

  return (
    <form action={formAction} className="shop-connect">
      <button type="submit" disabled={readOnly || pending}>
        {pending ? "Opening Stripe…" : label}
      </button>
      {state && !state.ok && (
        <p className="error" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
