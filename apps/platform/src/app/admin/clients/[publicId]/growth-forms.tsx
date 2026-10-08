"use client";

import { useActionState } from "react";
import type { GrantResult } from "@/db/repositories/admin/growth";
import { growthAddOnAction } from "./growth-actions";

/** Grant or remove one hand-given Growth add-on. */
export function GrowthAddOnButton({
  clientPublicId,
  feature,
  grant,
  label,
}: {
  clientPublicId: string;
  feature: string;
  grant: boolean;
  label: string;
}) {
  const [state, formAction, pending] = useActionState<GrantResult | null, FormData>(growthAddOnAction, null);
  return (
    <form action={formAction} className="plan-action">
      <input type="hidden" name="clientPublicId" value={clientPublicId} />
      <input type="hidden" name="feature" value={feature} />
      <input type="hidden" name="grant" value={grant ? "1" : "0"} />
      <button type="submit" className={grant ? "small" : "secondary small"} disabled={pending}>
        {pending ? "Saving…" : label}
      </button>
      {state && !state.ok && <p className="error">{state.message}</p>}
    </form>
  );
}
